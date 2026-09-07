import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
export const traceId = 'run_abcdef123456';
export function traceLine(seq: number, type: string, attrs = {}): string {
    return JSON.stringify({ seq, type, attrs, ts: '2026-09-07T00:00:00Z', mono_us: seq, turn: 0, actor: 'host' });
}
export async function writeTrace(runs: string, lines: string[], schema = '0.1.0', id = traceId): Promise<void> {
    const directory = path.join(runs, id);
    await mkdir(directory, { recursive: true });
    const raw = `${lines.join('\n')}\n`;
    await writeFile(path.join(directory, 'events.jsonl'), raw);
    await writeFile(path.join(directory, 'manifest.json'), JSON.stringify({ schema_version: schema, run_id: id,
        created_at: '2026-09-07T00:00:00Z', counts: { events: lines.length },
        integrity: { events_sha256: createHash('sha256').update(raw).digest('hex') } }));
}
