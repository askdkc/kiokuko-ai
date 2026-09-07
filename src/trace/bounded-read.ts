import { constants, type Stats } from 'node:fs';
import { lstat, open, realpath, type FileHandle } from 'node:fs/promises';
import path from 'node:path';
import { createScanner, SyntaxKind } from 'jsonc-parser';
import { parseStrictJson } from '../setup/strict-json.js';
import { KiokukoError } from '../errors.js';
export const TRACE_LIMITS = Object.freeze({ manifest: 256 * 1024, line: 1024 * 1024, depth: 64,
    nodes: 20000, buffer: 64 * 1024, batchBytes: 4 * 1024 * 1024, batchEvents: 2000,
    discovery: 200, aggregate: 64 * 1024, tools: 256, context: 4096, warnings: 32, syncMs: 120000 });
export class TraceInputError extends Error {
    constructor(readonly code: string, readonly retryable = false) { super(code); }
}
export function fileIdentity(s: Stats) {
    return { dev: s.dev, ino: s.ino, size: s.size, mtime: s.mtimeMs, ctime: s.ctimeMs };
}
export type TraceFileIdentity = ReturnType<typeof fileIdentity>;
export function sameFile(a: TraceFileIdentity, b: TraceFileIdentity): boolean {
    return a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtime === b.mtime && a.ctime === b.ctime;
}
export async function assertTracePath(target: string, root: string): Promise<void> {
    if (!path.isAbsolute(target) || !path.isAbsolute(root))
        throw new TraceInputError('invalid_path');
    const relative = path.relative(root, target);
    if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative))
        throw new TraceInputError('path_escape');
    const canonicalRoot = await realpath(root);
    if (await realpath(target) !== path.join(canonicalRoot, relative))
        throw new TraceInputError('symlink_rejected');
    let current = root;
    for (const part of relative.split(path.sep).filter(Boolean)) {
        current = path.join(current, part);
        if ((await lstat(current)).isSymbolicLink())
            throw new TraceInputError('symlink_rejected');
    }
}
export function traceCaptureRoot(runs: string): string {
    // Test adapters can use a dedicated arbitrary store; production registration
    // always supplies captureCwd/.orca/runs.
    return path.basename(runs) === 'runs' && path.basename(path.dirname(runs)) === '.orca'
        ? path.dirname(path.dirname(runs)) : path.dirname(runs);
}
export async function openTraceFile(target: string, root: string): Promise<{
    handle: FileHandle;
    identity: TraceFileIdentity;
}> {
    await assertTracePath(target, root);
    const before = await lstat(target);
    if (!before.isFile())
        throw new TraceInputError('not_regular_file');
    const handle = await open(target, constants.O_RDONLY | constants.O_NONBLOCK | (constants.O_NOFOLLOW ?? 0));
    try {
        const stat = await handle.stat();
        if (!stat.isFile() || !sameFile(fileIdentity(before), fileIdentity(stat)))
            throw new TraceInputError('file_changed', true);
        await assertTracePath(target, root);
        return { handle, identity: fileIdentity(stat) };
    }
    catch (error) {
        await handle.close();
        throw error;
    }
}
export async function verifyTraceFile(target: string, root: string, handle: FileHandle, before: TraceFileIdentity): Promise<void> {
    await assertTracePath(target, root);
    if (!sameFile(before, fileIdentity(await handle.stat())) || !sameFile(before, fileIdentity(await lstat(target)))) {
        throw new TraceInputError('file_changed', true);
    }
}
export async function readBoundedTraceFile(target: string, root: string, maximum: number): Promise<Buffer> {
    const { handle, identity } = await openTraceFile(target, root);
    try {
        if (identity.size > maximum)
            throw new TraceInputError('file_too_large');
        const parts: Buffer[] = [];
        let total = 0;
        for (;;) {
            const buffer = Buffer.alloc(Math.min(TRACE_LIMITS.buffer, maximum + 1 - total));
            const { bytesRead } = await handle.read(buffer, 0, buffer.length, total);
            if (bytesRead === 0)
                break;
            total += bytesRead;
            if (total > maximum)
                throw new TraceInputError('file_too_large');
            parts.push(buffer.subarray(0, bytesRead));
        }
        await verifyTraceFile(target, root, handle, identity);
        return Buffer.concat(parts, total);
    }
    finally {
        await handle.close();
    }
}
export function parseTraceJson(bytes: Buffer | string): unknown {
    let raw: string;
    try {
        raw = typeof bytes === 'string' ? bytes : new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    }
    catch {
        throw new TraceInputError('invalid_utf8');
    }
    const scanner = createScanner(raw);
    let depth = 0;
    let nodes = 0;
    for (;;) {
        const token = scanner.scan();
        if (token === SyntaxKind.EOF)
            break;
        if (++nodes > TRACE_LIMITS.nodes)
            throw new TraceInputError('json_nodes_exceeded');
        if (token === SyntaxKind.OpenBraceToken || token === SyntaxKind.OpenBracketToken) {
            if (++depth > TRACE_LIMITS.depth)
                throw new TraceInputError('json_depth_exceeded');
        }
        if (token === SyntaxKind.CloseBraceToken || token === SyntaxKind.CloseBracketToken)
            depth--;
    }
    try {
        return parseStrictJson(raw, { disallowComments: true, allowTrailingComma: false }, 'Invalid trace JSON');
    }
    catch (error) {
        if (error instanceof KiokukoError)
            throw new TraceInputError('invalid_json');
        throw error;
    }
}
