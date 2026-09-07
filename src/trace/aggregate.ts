import { z } from 'zod';
import type { OrcaTraceEvent, OrcaTraceIntegrity } from './orca-trace.js';
import type { JsonObject } from '../serialization/validate.js';
import { findSecretInValue } from '../memory/secrets.js';
import { KiokukoError } from '../errors.js';
import { TRACE_LIMITS } from './bounded-read.js';
const MAX_LISTED_ERRORS = 4, MAX_LISTED_FS_CHANGES = 8, MAX_LISTED_NOTES = 4;
const ORCA_TRACE_MAX_MEMORY_CANDIDATES = 8;
export interface TraceProjection {
    readonly events: number;
    readonly turns: number;
    readonly errorCount: number;
    readonly shellFailures: number;
    readonly runEnded: boolean;
    readonly exitCode: number | null;
    readonly otherToolCalls: number;
    readonly overflow: boolean;
    readonly warningCount: number;
    readonly skippedEventCount: number;
    readonly toolCalls: ReadonlyArray<{
        readonly name: string;
        readonly count: number;
    }>;
    readonly errors: ReadonlyArray<{
        readonly kind: string;
        readonly suite?: string;
        readonly seq: number;
    }>;
    readonly fsChanges: ReadonlyArray<{
        readonly path: string;
        readonly status: string;
    }>;
    readonly notes: ReadonlyArray<{
        readonly rule: string;
        readonly detail?: string;
    }>;
}
const count = z.number().int().nonnegative();
export const traceProjectionSchema = z.object({ events: count, turns: count, errorCount: count, shellFailures: count, runEnded: z.boolean(), exitCode: z.number().int().nullable(),
    otherToolCalls: count, overflow: z.boolean(), warningCount: count, skippedEventCount: count,
    toolCalls: z.array(z.object({ name: z.string().min(1), count }).strict()).max(256),
    errors: z.array(z.object({ kind: z.string(), suite: z.string().optional(), seq: count }).strict()).max(4),
    fsChanges: z.array(z.object({ path: z.string(), status: z.string() }).strict()).max(8),
    notes: z.array(z.object({ rule: z.string(), detail: z.string().optional() }).strict()).max(4),
}).strict();
function boundedText(value: unknown, maximum: number): string | undefined {
    if (typeof value !== 'string' || value.length === 0)
        return undefined;
    if (findSecretInValue(value) !== undefined)
        throw new KiokukoError('SECURITY_REJECTION', 'Trace value rejected');
    let result = '';
    let bytes = 0;
    for (const point of value) {
        const size = Buffer.byteLength(JSON.stringify(point), 'utf8') - 2;
        if (bytes + size > maximum)
            break;
        result += point;
        bytes += size;
    }
    return result;
}
export function applyTraceEvents(previous: TraceProjection | undefined, events: readonly OrcaTraceEvent[], warningCount = 0, skippedEventCount = 0): TraceProjection {
    const toolCounts = new Map<string, number>((previous?.toolCalls ?? []).map(x => [x.name, x.count]));
    let otherToolCalls = previous?.otherToolCalls ?? 0;
    let overflow = previous?.overflow ?? false;
    const text = (value: unknown, maximum: number) => { const result = boundedText(value, maximum); if (typeof value === 'string' && result !== value)
        overflow = true; return result; };
    const errors = [...(previous?.errors ?? [])];
    const fsChanges = [...(previous?.fsChanges ?? [])];
    const notes = [...(previous?.notes ?? [])];
    let errorCount = previous?.errorCount ?? 0;
    let shellFailures = previous?.shellFailures ?? 0;
    let turns = previous?.turns ?? 0;
    let runEnded = previous?.runEnded ?? false;
    let exitCode: number | null = previous?.exitCode ?? null;
    for (const event of events) {
        const attrs = (event.attrs ?? {}) as Record<string, unknown>;
        // Only these attributes can enter the aggregate. Unused shell environments
        // and payloads never cross the persistence boundary. Scan before truncation.
        const keys = event.type === 'error' ? ['kind', 'suite'] : event.type === 'tool.call' ? ['name'] : event.type === 'fs.change' ? ['path', 'status'] : event.type === 'note' ? ['rule', 'detail'] : [];
        const projected = Object.fromEntries(keys.filter(key => Object.hasOwn(attrs, key)).map(key => [key, attrs[key]]));
        if (findSecretInValue(projected) !== undefined)
            throw new KiokukoError('SECURITY_REJECTION', 'Trace attributes rejected');
        if (event.turn + 1 > turns)
            turns = event.turn + 1;
        if (event.type === 'run.end') {
            runEnded = true;
            if (typeof attrs.exit_code === 'number' && Number.isSafeInteger(attrs.exit_code))
                exitCode = attrs.exit_code;
            continue;
        }
        if (event.type === 'error') {
            errorCount += 1;
            const kind = text(attrs.kind, 200) ?? 'unknown';
            if (errors.length < MAX_LISTED_ERRORS) {
                const suite = text(attrs.suite, 200);
                errors.push(suite === undefined ? { kind, seq: event.seq } : { kind, suite, seq: event.seq });
            }
            continue;
        }
        if (event.type === 'tool.call') {
            const name = typeof attrs.name === 'string' && attrs.name.length > 0 ? attrs.name : undefined;
            if (name !== undefined) {
                if (toolCounts.has(name))
                    toolCounts.set(name, toolCounts.get(name)! + 1);
                else if (toolCounts.size < TRACE_LIMITS.tools && Buffer.byteLength(JSON.stringify([...toolCounts.keys(), name])) <= 32 * 1024)
                    toolCounts.set(name, 1);
                else {
                    otherToolCalls++;
                    overflow = true;
                }
            }
            continue;
        }
        if (event.type === 'fs.change') {
            const itemPath = text(attrs.path, 512);
            const status = text(attrs.status, 40);
            if (itemPath !== undefined && status !== undefined && fsChanges.length < MAX_LISTED_FS_CHANGES) {
                fsChanges.push({ path: itemPath, status });
            }
            continue;
        }
        if (event.type === 'note') {
            const rule = text(attrs.rule, 120) ?? 'unspecified';
            if (notes.length < MAX_LISTED_NOTES) {
                const detail = text(attrs.detail, 200);
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
        events: (previous?.events ?? 0) + events.length,
        otherToolCalls, overflow: overflow || errorCount > MAX_LISTED_ERRORS || fsChanges.length === MAX_LISTED_FS_CHANGES || notes.length === MAX_LISTED_NOTES,
        warningCount: (previous?.warningCount ?? 0) + warningCount,
        skippedEventCount: (previous?.skippedEventCount ?? 0) + skippedEventCount,
        turns,
        errorCount,
        shellFailures,
        runEnded,
        exitCode,
        toolCalls: [...toolCounts.entries()]
            .map(([name, count]) => ({ name, count })),
        errors,
        fsChanges,
        notes,
    };
}
interface TraceMemoryCandidateSet {
    readonly candidates: ReadonlyArray<{
        readonly kind: string;
        readonly summary: string;
    }>;
    readonly suppressed: number;
}
export function buildTraceMemoryCandidates(projection: TraceProjection): TraceMemoryCandidateSet {
    const candidates: Array<{
        kind: string;
        summary: string;
    }> = [];
    let suppressed = 0;
    const consider = (kind: 'error' | 'shell_failure' | 'note', summary: string): void => {
        if (candidates.length >= ORCA_TRACE_MAX_MEMORY_CANDIDATES)
            return;
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
export function buildTraceContext(traceRunId: string, schemaVersion: string, throughSeq: number, integrity: OrcaTraceIntegrity, projection: TraceProjection, metadata: JsonObject): TraceContextBuild {
    let toolCalls = [...projection.toolCalls].sort((a, b) => b.count - a.count || (a.name < b.name ? -1 : 1)).slice(0, 8).map(x => ({ ...x, name: boundedText(x.name, 200)! }));
    let errors = projection.errors;
    let fsChanges = projection.fsChanges;
    let notes = projection.notes;
    let detailsTruncated = projection.overflow || projection.toolCalls.length > 8 || projection.toolCalls.some(x => boundedText(x.name, 200) !== x.name);
    const build = (): JsonObject => ({
        ...metadata,
        source: 'orcareplay',
        referenceOnly: true, autoInstall: false, autoExecute: false,
        completeness: { parse: projection.warningCount > 0 ? 'partial' : 'complete', warningCount: projection.warningCount, skippedEventCount: projection.skippedEventCount, detailsTruncated },
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
            exitCode: projection.exitCode,
            otherToolCalls: projection.otherToolCalls, overflow: projection.overflow,
            toolCalls: [...toolCalls],
            errors: [...errors],
            fsChanges: [...fsChanges],
            notes: [...notes],
        },
    });
    const byteLength = (value: JsonObject): number => Buffer.byteLength(JSON.stringify(value), 'utf8');
    let candidate = build();
    while (byteLength(candidate) > (TRACE_LIMITS.context - 400)) {
        detailsTruncated = true;
        if (fsChanges.length > 1)
            fsChanges = fsChanges.slice(0, Math.max(1, Math.floor(fsChanges.length / 2)));
        else if (toolCalls.length > 1)
            toolCalls = toolCalls.slice(0, Math.max(1, Math.floor(toolCalls.length / 2)));
        else if (errors.length > 1)
            errors = errors.slice(0, Math.max(1, Math.floor(errors.length / 2)));
        else if (notes.length > 1)
            notes = notes.slice(0, Math.max(1, Math.floor(notes.length / 2)));
        else {
            fsChanges = [];
            toolCalls = [];
            errors = [];
            notes = [];
        }
        candidate = build();
        if (fsChanges.length === 0 && toolCalls.length === 0 && errors.length === 0 && notes.length === 0
            && byteLength(candidate) <= (TRACE_LIMITS.context - 400))
            break;
        if (fsChanges.length === 0 && toolCalls.length === 0 && errors.length === 0 && notes.length === 0
            && byteLength(candidate) > (TRACE_LIMITS.context - 400)) {
            return { context: candidate, bounded: false };
        }
    }
    return { context: candidate, bounded: true };
}
