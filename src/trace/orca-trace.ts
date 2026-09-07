import { createHash } from 'node:crypto';
import { setImmediate as yieldToLoop } from 'node:timers/promises';
import { TRACE_LIMITS, TraceInputError, parseTraceJson, readBoundedTraceFile, traceCaptureRoot, openTraceFile, verifyTraceFile, type TraceFileIdentity } from './bounded-read.js';
import path from 'node:path';
import { KiokukoError } from '../errors.js';
import type { JsonObject, JsonValue } from '../serialization/validate.js';
export const ORCA_TRACE_READER_POLICY_VERSION = 2 as const;
export const ORCA_TRACE_INLINE_PAYLOAD_BYTES = TRACE_LIMITS.context;
export const ORCA_TRACE_MAX_WARNINGS = TRACE_LIMITS.warnings;
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
export type OrcaTraceWarningCode = 'truncated_final_line' | 'invalid_event' | 'unknown_event_type' | 'seq_gap' | 'blob_unresolved' | 'events_too_large' | 'event_line_too_large';
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
    readonly createdAt?: string;
    readonly endedAt?: string;
    readonly derived?: boolean;
}
export type OrcaTraceReadStatus = 'ready' | 'unsupported_schema' | 'missing_manifest' | 'missing_events' | 'invalid_manifest' | 'missing_run_directory';
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
    if (typeof value !== 'object' || value === null || Array.isArray(value))
        return false;
    return Object.getPrototypeOf(value) === Object.prototype;
}
function isSafeInteger(value: unknown): value is number {
    return typeof value === 'number' && Number.isSafeInteger(value);
}
function pushWarning(warnings: OrcaTraceWarning[], warning: OrcaTraceWarning): void {
    if (warnings.length < ORCA_TRACE_MAX_WARNINGS)
        warnings.push(warning);
}
export interface ParsedOrcaTraceManifest {
    readonly schemaVersion: string;
    readonly runId: string;
    readonly countsEvents: number | undefined;
    readonly eventsSha256: string | undefined;
    readonly createdAt?: string;
    readonly endedAt?: string;
    readonly derived?: boolean;
}
export type OrcaTraceManifestRead = {
    readonly ok: true;
    readonly manifest: ParsedOrcaTraceManifest;
    readonly fingerprint: string;
} | {
    readonly ok: false;
    readonly reason: 'missing_manifest' | 'invalid_manifest' | 'unsupported_schema';
    readonly schemaVersion?: string;
};
function parseManifest(raw: string, traceRunId: string): ParsedOrcaTraceManifest | undefined {
    let parsed: unknown;
    try {
        parsed = parseTraceJson(raw);
    }
    catch {
        return undefined;
    }
    if (!isPlainRecord(parsed))
        return undefined;
    const schemaVersion = parsed.schema_version;
    const runId = parsed.run_id;
    if (typeof schemaVersion !== 'string' || schemaVersion.length === 0 || schemaVersion.length > 64)
        return undefined;
    if (typeof runId !== 'string' || !ORCA_TRACE_RUN_ID_PATTERN.test(runId) || runId !== traceRunId)
        return undefined;
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
    for (const key of ['created_at', 'ended_at']) {
        if (parsed[key] !== undefined && parsed[key] !== null && (typeof parsed[key] !== 'string' || !RFC3339_PATTERN.test(parsed[key]) || !Number.isFinite(Date.parse(parsed[key]))))
            return undefined;
    }
    if (parsed.counts !== undefined && (counts === undefined || countsEvents === undefined))
        return undefined;
    if (integrity?.events_sha256 !== undefined && eventsSha256 === undefined)
        return undefined;
    return { schemaVersion, runId, countsEvents, eventsSha256,
        ...(typeof parsed.created_at === 'string' ? { createdAt: parsed.created_at } : {}),
        ...(typeof parsed.ended_at === 'string' ? { endedAt: parsed.ended_at } : {}),
        derived: parsed.parent_run_id != null || parsed.fork != null || parsed.parent != null,
    };
}
export async function readOrcaTraceManifest(runsDirectory: string, traceRunId: string): Promise<OrcaTraceManifestRead> {
    if (typeof runsDirectory !== 'string' || !path.isAbsolute(runsDirectory) || runsDirectory.length > 4096) {
        throw new KiokukoError('VALIDATION_ERROR', 'OrcaReplay runs directory must be a bounded absolute path');
    }
    if (typeof traceRunId !== 'string' || !ORCA_TRACE_RUN_ID_PATTERN.test(traceRunId)) {
        throw new KiokukoError('VALIDATION_ERROR', 'OrcaReplay trace run ID is invalid');
    }
    const runDirectory = path.join(runsDirectory, traceRunId);
    let raw: string;
    try {
        const bytes = await readBoundedTraceFile(path.join(runDirectory, 'manifest.json'), traceCaptureRoot(runsDirectory), TRACE_LIMITS.manifest);
        try {
            raw = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
        }
        catch {
            throw new TraceInputError('invalid_utf8');
        }
    }
    catch (error) {
        const code = error instanceof Error && 'code' in error ? (error as NodeJS.ErrnoException).code : undefined;
        if (code === 'ENOENT' || code === 'ENOTDIR')
            return { ok: false, reason: 'missing_manifest' };
        if (code === 'EACCES' || code === 'EPERM')
            return { ok: false, reason: 'invalid_manifest' };
        throw error;
    }
    const manifest = parseManifest(raw, traceRunId);
    if (manifest === undefined)
        return { ok: false, reason: 'invalid_manifest' };
    if (!SUPPORTED_SCHEMA_PATTERN.test(manifest.schemaVersion)) {
        return { ok: false, reason: 'unsupported_schema', schemaVersion: manifest.schemaVersion };
    }
    return { ok: true, manifest, fingerprint: createHash('sha256').update(raw).digest('hex') };
}
function descriptor(hex: string, bytes: number, mediaType: string | undefined): OrcaTraceBlobDescriptor {
    return mediaType === undefined
        ? { blobDigest: hex, bytes }
        : { blobDigest: hex, bytes, mediaType };
}
type BlobResolution = {
    readonly ok: true;
    readonly value?: JsonValue | OrcaTraceBlobDescriptor;
} | {
    readonly ok: false;
    readonly detail: string;
};
export async function resolveBlobPayload(runDirectory: string, reference: Record<string, unknown>): Promise<BlobResolution> {
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
        bytes = await readBoundedTraceFile(blobPath, traceCaptureRoot(path.dirname(runDirectory)), ORCA_TRACE_INLINE_PAYLOAD_BYTES);
    }
    catch {
        return { ok: false, detail: `blob ${hex} is missing` };
    }
    if ((declaredBytes !== undefined && declaredBytes !== bytes.byteLength) || createHash('sha256').update(bytes).digest('hex') !== hex) {
        return { ok: false, detail: `blob ${hex} does not match its digest` };
    }
    const mediaType = typeof reference.media_type === 'string' ? reference.media_type : undefined;
    if (bytes.byteLength <= ORCA_TRACE_INLINE_PAYLOAD_BYTES) {
        try {
            return { ok: true, value: JSON.parse(bytes.toString('utf8')) as JsonValue };
        }
        catch {
            return { ok: true, value: descriptor(hex, bytes.byteLength, mediaType) };
        }
    }
    return { ok: true, value: descriptor(hex, declaredBytes === undefined ? bytes.byteLength : declaredBytes, mediaType) };
}
function requiresString(value: unknown): value is string {
    return typeof value === 'string' && value.length > 0;
}
type TraceLineParse = {
    readonly kind: 'event';
    readonly event: OrcaTraceEvent;
    readonly seqGap: boolean;
} | {
    readonly kind: 'skip';
    readonly warning: OrcaTraceWarning;
} | {
    readonly kind: 'skipAfterSeq';
    readonly warning: OrcaTraceWarning;
    readonly seq: number;
};
function parseTraceLine(runDirectory: string, line: string, previousSeq: number, expandBlobs = false): Promise<TraceLineParse> {
    let parsed: unknown;
    try {
        parsed = parseTraceJson(line);
    }
    catch {
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
        : expandBlobs ? resolveBlobPayload(runDirectory, payloadReference) : Promise.resolve<BlobResolution>(typeof payloadReference.$blob === 'string' && BLOB_DIGEST_PATTERN.test(payloadReference.$blob)
            && isSafeInteger(payloadReference.bytes) && payloadReference.bytes > 0
            ? { ok: true, value: descriptor(payloadReference.$blob.slice(7), payloadReference.bytes, typeof payloadReference.media_type === 'string' ? payloadReference.media_type : undefined) }
            : { ok: false, detail: 'invalid_blob_reference' })).then((resolution) => {
        if (!resolution.ok) {
            return {
                kind: 'event' as const,
                event: { seq, ts, monoUs, turn, type, actor, unknownType: !ORCA_TRACE_EVENT_TYPES.includes(type as OrcaTraceEventType), ...(attrs === undefined ? {} : { attrs: attrs as JsonObject }), payload: { unresolved: true } },
                seqGap: previousSeq >= 0 && seq > previousSeq + 1,
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
        if (causes !== undefined)
            event.causes = causes as number[];
        if (attrs !== undefined)
            event.attrs = attrs as JsonObject;
        if (resolution.value !== undefined)
            event.payload = resolution.value;
        if (redacted !== undefined)
            event.redacted = redacted as string[];
        return {
            kind: 'event' as const,
            event,
            seqGap: previousSeq >= 0 && seq > previousSeq + 1,
        };
    });
}
export interface TraceBatchOptions {
    offset?: number;
    lastSeq?: number;
    maxBytes?: number;
    maxEvents?: number;
    final?: boolean;
    signal?: AbortSignal;
    hash?: ReturnType<typeof createHash>;
}
export interface TraceReadBatch {
    nextByteOffset: number;
    lastSeq: number;
    hasMore: boolean;
    waitingForCompleteLine: boolean;
    fileIdentity: TraceFileIdentity;
    events: OrcaTraceEvent[];
    warnings: OrcaTraceWarning[];
    warningCount: number;
    skippedEventCount: number;
}
export async function readTraceBatch(runs: string, id: string, options: TraceBatchOptions = {}): Promise<TraceReadBatch> {
    if (!ORCA_TRACE_RUN_ID_PATTERN.test(id))
        throw new TraceInputError('invalid_run_id');
    const target = path.join(runs, id, 'events.jsonl');
    const root = traceCaptureRoot(runs);
    const { handle, identity } = await openTraceFile(target, root);
    let offset = options.offset ?? 0;
    let position = offset;
    let lastSeq = options.lastSeq ?? -1;
    const maxBytes = options.maxBytes ?? TRACE_LIMITS.batchBytes;
    const maxEvents = options.maxEvents ?? TRACE_LIMITS.batchEvents;
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > identity.size || !Number.isSafeInteger(maxBytes) || maxBytes < 1 || !Number.isSafeInteger(maxEvents) || maxEvents < 1) {
        await handle.close();
        throw new TraceInputError('invalid_read_bounds');
    }
    const events: OrcaTraceEvent[] = [];
    const warnings: OrcaTraceWarning[] = [];
    let warningCount = 0;
    let skippedEventCount = 0;
    let pending = Buffer.alloc(0);
    let waiting = false;
    const warn = (warning: OrcaTraceWarning) => { warningCount++; if (warnings.length < TRACE_LIMITS.warnings)
        warnings.push({ code: warning.code }); };
    const consume = async (line: Buffer, raw: Buffer) => {
        options.signal?.throwIfAborted();
        let text: string;
        try {
            text = new TextDecoder('utf-8', { fatal: true }).decode(line);
        }
        catch {
            warn({ code: 'invalid_event' });
            skippedEventCount++;
            offset += raw.length;
            options.hash?.update(raw);
            return;
        }
        const parsed = await parseTraceLine(path.join(runs, id), text, lastSeq);
        if (parsed.kind !== 'event') {
            warn(parsed.warning);
            skippedEventCount++;
            if (parsed.kind === 'skipAfterSeq')
                lastSeq = parsed.seq;
        }
        else {
            if (parsed.seqGap)
                warn({ code: 'seq_gap' });
            if (parsed.event.unknownType)
                warn({ code: 'unknown_event_type' });
            if (typeof parsed.event.payload === 'object' && parsed.event.payload !== null && 'unresolved' in parsed.event.payload)
                warn({ code: 'blob_unresolved' });
            events.push(parsed.event);
            lastSeq = parsed.event.seq;
        }
        offset += raw.length;
        options.hash?.update(raw);
    };
    try {
        let done = false;
        while (!done) {
            options.signal?.throwIfAborted();
            const buffer = Buffer.alloc(Math.min(TRACE_LIMITS.buffer, Math.max(1, identity.size - position)));
            const { bytesRead } = await handle.read(buffer, 0, buffer.length, position);
            position += bytesRead;
            pending = Buffer.concat([pending, buffer.subarray(0, bytesRead)]);
            for (;;) {
                const lf = pending.indexOf(10);
                if (lf < 0)
                    break;
                if (lf > TRACE_LIMITS.line)
                    throw new TraceInputError('event_line_too_large');
                const raw = pending.subarray(0, lf + 1);
                await consume(raw.subarray(0, lf), raw);
                pending = pending.subarray(lf + 1);
                if (offset - (options.offset ?? 0) >= maxBytes || events.length >= maxEvents) {
                    done = true;
                    break;
                }
            }
            if (pending.length > TRACE_LIMITS.line)
                throw new TraceInputError('event_line_too_large');
            if (done)
                break;
            if (bytesRead === 0 || position >= identity.size) {
                if (pending.length > 0) {
                    if (options.final === true)
                        await consume(pending, pending);
                    else
                        waiting = true;
                }
                break;
            }
            await yieldToLoop();
        }
        await verifyTraceFile(target, root, handle, identity);
        return { nextByteOffset: offset, lastSeq, hasMore: offset < identity.size && !waiting, waitingForCompleteLine: waiting,
            fileIdentity: identity, events, warnings, warningCount, skippedEventCount };
    }
    finally {
        await handle.close();
    }
}
/** Bounded inspection API. Ingestion uses the resumable batch API. */
export async function readOrcaTraceRun(runsDirectory: string, traceRunId: string): Promise<OrcaTraceRunRead> {
    const read = await readOrcaTraceManifest(runsDirectory, traceRunId);
    if (!read.ok)
        return { status: read.reason, integrity: 'unavailable', events: [], maxSeq: -1, warnings: [] };
    const hash = createHash('sha256');
    const batch = await readTraceBatch(runsDirectory, traceRunId, { hash, final: read.manifest.endedAt !== undefined });
    const integrity = batch.hasMore || batch.waitingForCompleteLine || !read.manifest.eventsSha256 ? 'unavailable'
        : hash.digest('hex') === read.manifest.eventsSha256 ? 'verified' : 'mismatch';
    return { status: 'ready', integrity, manifest: manifestView(read.manifest), events: batch.events, maxSeq: batch.lastSeq,
        warnings: [...batch.warnings, ...(batch.waitingForCompleteLine ? [{ code: 'truncated_final_line' as const }] : [])] };
}
function manifestView(manifest: ParsedOrcaTraceManifest): OrcaTraceManifestView {
    return { schemaVersion: manifest.schemaVersion, runId: manifest.runId,
        ...(manifest.countsEvents === undefined ? {} : { countsEvents: manifest.countsEvents }),
        ...(manifest.eventsSha256 === undefined ? {} : { eventsSha256: manifest.eventsSha256 }),
        ...(manifest.createdAt === undefined ? {} : { createdAt: manifest.createdAt }),
        ...(manifest.endedAt === undefined ? {} : { endedAt: manifest.endedAt }), derived: manifest.derived ?? false };
}
