import path from 'node:path';
import { realpath, lstat } from 'node:fs/promises';
import type { SqliteDatabase } from '../db/adapter.js';
import { detectRepositoryRoot } from '../repository/detect-root.js';
import { assertTracePath, TraceInputError } from './bounded-read.js';
export interface TraceStoreLocation {
    repositoryRoot: string;
    captureCwd: string;
    runsDirectory: string;
}
export async function resolveTraceStoreLocation(cwd: string, repositoryRoot?: string): Promise<TraceStoreLocation> {
    const captureCwd = await realpath(cwd);
    const root = repositoryRoot === undefined ? detectRepositoryRoot({ cwd: captureCwd, allowDirectory: true }).root : await realpath(repositoryRoot);
    const relative = path.relative(root, captureCwd);
    if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative))
        throw new TraceInputError('capture_outside_repository');
    return { repositoryRoot: root, captureCwd, runsDirectory: path.join(captureCwd, '.orca', 'runs') };
}
export function registerTraceStore(database: SqliteDatabase, location: TraceStoreLocation): void {
    // Only resolved host location data reaches this registration boundary.
    if (Object.values(location).some(x => !path.isAbsolute(x) || x.length > 4096 || /[\x00-\x1f\x7f]/u.test(x)))
        throw new TraceInputError('invalid_store_location');
    if (location.runsDirectory !== path.join(location.captureCwd, '.orca', 'runs'))
        throw new TraceInputError('invalid_store_location');
    const existing = database.prepare('SELECT repository_root AS root,capture_cwd AS cwd FROM orcareplay_trace_stores WHERE directory=?').get<{
        root: string;
        cwd: string;
    }>(location.runsDirectory);
    if (existing && (existing.root !== location.repositoryRoot || existing.cwd !== location.captureCwd))
        throw new TraceInputError('store_identity_conflict');
    database.prepare("INSERT INTO orcareplay_trace_stores(directory,repository_root,capture_cwd,state) VALUES(?,?,?,'pending') ON CONFLICT(directory) DO NOTHING").run(location.runsDirectory, location.repositoryRoot, location.captureCwd);
}
export async function validateTraceStore(location: TraceStoreLocation): Promise<'present' | 'missing'> {
    try {
        await assertTracePath(location.runsDirectory, location.captureCwd);
        if (!(await lstat(location.runsDirectory)).isDirectory())
            throw new TraceInputError('store_not_directory');
        return 'present';
    }
    catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT')
            return 'missing';
        throw error;
    }
}
