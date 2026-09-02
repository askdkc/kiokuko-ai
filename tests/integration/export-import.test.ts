import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import {
  appendFile,
  chmod,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import { initializeDatabase } from '../../src/commands/init.js';
import { openConnection } from '../../src/db/connection.js';
import { exportWorkspace, writeExport } from '../../src/commands/export.js';
import {
  WORKSPACE_ARCHIVE_MAX_BYTES,
  WORKSPACE_ARCHIVE_MAX_LINES,
  WORKSPACE_ARCHIVE_MAX_LINE_BYTES,
  importWorkspace,
} from '../../src/commands/import.js';
import type { SqliteDatabase, SqliteRow, SqliteStatement, SqliteValue } from '../../src/db/adapter.js';
import { recordEntry, updateCandidateEntry } from '../../src/memory/entries.js';
import { linkEntries, promoteEntry, supersedeEntry } from '../../src/memory/lifecycle.js';
import { createBackup } from '../../src/commands/backup.js';
import { runDoctor } from '../../src/commands/doctor.js';
import { AgentGatewayService } from '../../src/gateway/agent-service.js';
import { createRuntimeDescriptor, writeRuntimeDescriptor } from '../../src/server/runtime-descriptor.js';
import { readNudgeHistory, recordNudgeDeliveryInTransaction } from '../../src/context/nudge-store.js';
import { exportLedgerArchive } from '../../src/ledger/archive.js';
import { inspectLedger } from '../../src/ledger/maintenance.js';
import {
  canonicalEntryRevisionContentHash,
  canonicalJson,
  type EntryKind,
} from '../../src/serialization/validate.js';
import { MAX_STRICT_JSON_DEPTH } from '../../src/setup/strict-json.js';

const execFileAsync = promisify(execFile);

async function database(prefix: string) {
  const directory = await mkdtemp(path.join(tmpdir(), `kiokuko-${prefix}-`));
  const databasePath = path.join(directory, 'kiokuko-ai.sqlite');
  await initializeDatabase({ databasePath });
  const db = openConnection(databasePath);
  return { db, databasePath, directory };
}

function openDoctorConnectionWithFailures(
  operationFailure: unknown,
  closeFailure: unknown,
): typeof openConnection {
  return (filePath, options) => {
    const database = openConnection(filePath, options);
    return new Proxy(database, {
      get(target, property) {
        if (property === 'prepare') {
          return (sql: string) => {
            if (sql === 'PRAGMA integrity_check') throw operationFailure;
            return target.prepare(sql);
          };
        }
        if (property === 'close') {
          return () => {
            target.close();
            throw closeFailure;
          };
        }
        const value = Reflect.get(target, property, target) as unknown;
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
  };
}

function rebuildWorkspaceArchive(
  content: string,
  mutate: (payload: Record<string, unknown>[]) => void,
): string {
  assert.equal(content.endsWith('\n'), true);
  const lines = content.slice(0, -1).split('\n');
  const payload = lines.slice(1).map((line) => JSON.parse(line) as Record<string, unknown>);
  mutate(payload);
  const payloadText = `${payload.map((line) => canonicalJson(line)).join('\n')}\n`;
  const checksum = createHash('sha256').update(payloadText, 'utf8').digest('hex');
  return `${canonicalJson({ type: 'checksum', sha256: checksum })}\n${payloadText}`;
}

function rebuildWorkspaceArchiveLines(
  content: string,
  mutate: (payloadLines: string[]) => void,
): string {
  assert.equal(content.endsWith('\n'), true);
  const lines = content.slice(0, -1).split('\n');
  const payloadLines = lines.slice(1);
  mutate(payloadLines);
  const payloadText = `${payloadLines.join('\n')}\n`;
  const checksum = createHash('sha256').update(payloadText, 'utf8').digest('hex');
  return `${canonicalJson({ type: 'checksum', sha256: checksum })}\n${payloadText}`;
}

function assertArchiveTablesEmpty(db: ReturnType<typeof openConnection>): void {
  for (const table of [
    'entries',
    'entry_revisions',
    'entry_revision_tags',
    'entry_links',
    'audit_events',
    'entries_fts',
    'entry_search_documents',
    'entry_search_signals',
  ]) {
    assert.equal(
      db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get<{ count: number }>()?.count,
      0,
      `${table} must remain empty`,
    );
  }
}

function rowCounts(db: ReturnType<typeof openConnection>): Record<string, number> {
  return Object.fromEntries(
    [
      'entries',
      'entry_revisions',
      'entry_revision_tags',
      'entry_links',
      'audit_events',
      'entries_fts',
      'entry_search_documents',
      'entry_search_signals',
    ].map((table) => [
      table,
      db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get<{ count: number }>()?.count ?? -1,
    ]),
  );
}

function archiveReplayState(db: ReturnType<typeof openConnection>): Record<string, unknown> {
  return {
    counts: rowCounts(db),
    fullText: db.prepare(`
      SELECT rowid, title, body, summary, tags_text
        FROM entries_fts
       ORDER BY rowid ASC
    `).all(),
    documents: db.prepare(`
      SELECT entry_rowid, entry_id, title, body, summary, tags_text
        FROM entry_search_documents
       ORDER BY entry_rowid ASC
    `).all(),
    signals: db.prepare(`
      SELECT entry_id, signal_type, normalized_value
        FROM entry_search_signals
       ORDER BY entry_id ASC, signal_type ASC, normalized_value ASC
    `).all(),
  };
}

function recomputeArchiveEntryHash(payload: Record<string, unknown>[], entryId: string): void {
  const entry = payload.find((line) => line.type === 'entry' && line.id === entryId);
  assert.ok(entry);
  const tags = payload
    .filter((line) => line.type === 'tag' && line.entry_id === entryId)
    .map((line) => String(line.tag));
  entry.content_hash = canonicalEntryRevisionContentHash({
    kind: entry.kind as EntryKind,
    title: String(entry.title),
    body: String(entry.body),
    summary: entry.summary === null ? null : String(entry.summary),
    scope: JSON.parse(String(entry.scope_json)) as Record<string, never>,
    provenance: JSON.parse(String(entry.provenance_json)) as Record<string, never>,
    tags,
  });
}

function hookedDatabase(
  database: SqliteDatabase,
  afterFirstEntrySelect: () => void,
): { database: SqliteDatabase; events: string[]; inTransaction: () => boolean } {
  const events: string[] = [];
  let inTransaction = false;
  let mutationTriggered = false;
  return {
    events,
    inTransaction: () => inTransaction,
    database: {
      filePath: database.filePath,
      exec(sql: string): void {
        database.exec(sql);
        const normalized = sql.trim().toUpperCase();
        if (normalized.startsWith('BEGIN')) {
          inTransaction = true;
          events.push('begin');
        } else if (normalized.startsWith('COMMIT')) {
          inTransaction = false;
          events.push('commit');
        } else if (normalized.startsWith('ROLLBACK')) {
          inTransaction = false;
          events.push('rollback');
        }
      },
      prepare(sql: string): SqliteStatement {
        const statement = database.prepare(sql);
        const isEntryList = /SELECT\s+id\s+FROM\s+entries\s+WHERE\s+workspace/u.test(sql);
        return {
          run(...parameters: SqliteValue[]): void {
            statement.run(...parameters);
          },
          get<T extends SqliteRow = SqliteRow>(...parameters: SqliteValue[]): T | undefined {
            return statement.get<T>(...parameters);
          },
          all<T extends SqliteRow = SqliteRow>(...parameters: SqliteValue[]): T[] {
            const result = statement.all<T>(...parameters);
            if (isEntryList) {
              events.push('entry-select');
              if (!mutationTriggered) {
                mutationTriggered = true;
                assert.equal(inTransaction, true, 'the snapshot transaction must begin before the first archive SELECT');
                afterFirstEntrySelect();
              }
            }
            return result;
          },
        };
      },
      close(): void {
        database.close();
      },
    },
  };
}

test('export/import round-trips entries, tags, links, and audit deterministically', async () => {
  const source = await database('export-source');
  const target = await database('export-target');
  const exportPath = path.join(source.directory, 'memory.jsonl');
  try {
    const first = recordEntry(source.db, {
      workspace: 'project:export',
      kind: 'decision',
      title: 'SQLite driver',
      body: 'Use the standard driver.',
      tags: ['db', 'verified'],
      provenance: { type: 'document', reference: 'docs/database.md' },
    });
    const second = recordEntry(source.db, {
      workspace: 'project:export',
      kind: 'lesson',
      title: 'Locking',
      body: 'Use bounded retry.',
      tags: ['db'],
    });
    promoteEntry(source.db, { workspace: 'project:export', entryId: first.id, expectedRevision: 1 });
    linkEntries(source.db, { workspace: 'project:export', fromEntryId: second.id, toEntryId: first.id, relation: 'derived_from' });
    const exported = await writeExport(source.db, { workspace: 'project:export', output: exportPath });
    await importWorkspace(target.db, { input: exportPath });
    const imported = exportWorkspace(target.db, { workspace: 'project:export' });
    assert.equal(imported.content, exported.content);
    assert.equal(imported.count, 2);
    const duplicate = await importWorkspace(target.db, { input: exportPath });
    assert.deepEqual(duplicate, { count: 2, imported: 0, duplicates: 2, dryRun: false, workspace: 'project:export' });
    const dryRun = await importWorkspace(target.db, { input: exportPath, dryRun: true });
    assert.deepEqual(dryRun, { count: 2, imported: 0, duplicates: 2, dryRun: true, workspace: 'project:export' });
    assert.equal((await readFile(exportPath, 'utf8')).startsWith('{"sha256":"'), true);
  } finally {
    source.db.close();
    target.db.close();
  }
});

test('import rejects checksum corruption without mutating the database', async () => {
  const source = await database('export-corrupt-source');
  const target = await database('export-corrupt-target');
  const exportPath = path.join(source.directory, 'memory.jsonl');
  const corruptPath = path.join(source.directory, 'corrupt.jsonl');
  try {
    recordEntry(source.db, { workspace: 'project:corrupt', kind: 'fact', title: 'Fact', body: 'Original' });
    await writeExport(source.db, { workspace: 'project:corrupt', output: exportPath });
    const content = await readFile(exportPath, 'utf8');
    await import('node:fs/promises').then(({ writeFile }) => writeFile(corruptPath, content.replace('Original', 'Changed')));
    await assert.rejects(importWorkspace(target.db, { input: corruptPath, dryRun: true }), /checksum/i);
    assert.equal(target.db.prepare('SELECT COUNT(*) AS count FROM entries').get<{ count: number }>()?.count, 0);
  } finally {
    source.db.close();
    target.db.close();
  }
});

test('import rejects incomplete, duplicate, unknown, malformed, and count-mismatched v2 records', async () => {
  const source = await database('export-strict-source');
  const target = await database('export-strict-target');
  const exportPath = path.join(source.directory, 'memory.jsonl');
  try {
    recordEntry(source.db, {
      workspace: 'project:strict-import',
      kind: 'fact',
      title: 'Strict archive',
      body: 'Reject schema drift before writing.',
    });
    const archive = (await writeExport(source.db, {
      workspace: 'project:strict-import',
      output: exportPath,
    })).content;
    const cases: Array<{
      name: string;
      code: 'VALIDATION_ERROR' | 'INTEGRITY_ERROR';
      mutate: (payload: Record<string, unknown>[]) => void;
    }> = [
      {
        name: 'omitted manifest count',
        code: 'VALIDATION_ERROR',
        mutate: (payload) => {
          delete (payload[0]!.counts as Record<string, unknown>).audit;
        },
      },
      {
        name: 'duplicate manifest',
        code: 'INTEGRITY_ERROR',
        mutate: (payload) => {
          payload.push({ ...payload[0]!, counts: { ...(payload[0]!.counts as Record<string, unknown>) } });
        },
      },
      {
        name: 'unknown record type',
        code: 'VALIDATION_ERROR',
        mutate: (payload) => {
          payload.push({ type: 'unknown-record' });
        },
      },
      {
        name: 'extra record field',
        code: 'VALIDATION_ERROR',
        mutate: (payload) => {
          payload.find((line) => line.type === 'entry')!.unexpected = true;
        },
      },
      {
        name: 'malformed record field',
        code: 'VALIDATION_ERROR',
        mutate: (payload) => {
          payload.find((line) => line.type === 'entry')!.confidence = '0.5';
        },
      },
      {
        name: 'unrepresentable revision history',
        code: 'VALIDATION_ERROR',
        mutate: (payload) => {
          payload.find((line) => line.type === 'entry')!.revision = 2;
        },
      },
      {
        name: 'record count mismatch',
        code: 'INTEGRITY_ERROR',
        mutate: (payload) => {
          const counts = payload[0]!.counts as Record<string, unknown>;
          counts.entries = Number(counts.entries) + 1;
        },
      },
    ];

    for (const fixture of cases) {
      const invalidPath = path.join(source.directory, `${fixture.name.replaceAll(' ', '-')}.jsonl`);
      await writeFile(invalidPath, rebuildWorkspaceArchive(archive, fixture.mutate), 'utf8');
      await assert.rejects(
        importWorkspace(target.db, { input: invalidPath }),
        (error: unknown) => (error as { code?: string }).code === fixture.code,
        fixture.name,
      );
    }
    assert.equal(target.db.prepare('SELECT COUNT(*) AS count FROM entries').get<{ count: number }>()?.count, 0);
  } finally {
    source.db.close();
    target.db.close();
  }
});

test('workspace archive v1 refuses revision history without creating or overwriting output', async () => {
  const source = await database('export-revision-history');
  const missingPath = path.join(source.directory, 'missing-output.jsonl');
  const existingPath = path.join(source.directory, 'existing-output.jsonl');
  try {
    const first = recordEntry(source.db, {
      workspace: 'project:revision-history',
      kind: 'lesson',
      title: 'Original',
      body: 'Revision one.',
    });
    updateCandidateEntry(source.db, {
      workspace: first.workspace,
      entryId: first.id,
      expectedRevision: first.revision,
      kind: first.kind,
      title: 'Updated',
      body: 'Revision two cannot be flattened into workspace archive v1.',
    });
    await writeFile(existingPath, 'preserve-me', 'utf8');

    for (const output of [missingPath, existingPath]) {
      await assert.rejects(
        writeExport(source.db, { workspace: first.workspace, output }),
        (error: unknown) => (error as { code?: string }).code === 'VALIDATION_ERROR'
          && /revision history/i.test((error as Error).message),
      );
    }

    await assert.rejects(readFile(missingPath), (error: unknown) => (error as NodeJS.ErrnoException).code === 'ENOENT');
    assert.equal(await readFile(existingPath, 'utf8'), 'preserve-me');
  } finally {
    source.db.close();
  }
});

test('import rejects impossible entry lifecycle states before mutating any archive table', async () => {
  const source = await database('export-lifecycle-source');
  const target = await database('export-lifecycle-target');
  const workspace = 'project:archive-lifecycle';
  try {
    const first = recordEntry(source.db, {
      workspace,
      kind: 'fact',
      title: 'Lifecycle source',
      body: 'The archive must preserve possible lifecycle state.',
      createdBy: 'archive-test',
    }, { now: '2026-08-20T00:00:00.000Z', idFactory: () => 'lifecycle-first' });
    const second = recordEntry(source.db, {
      workspace,
      kind: 'fact',
      title: 'Lifecycle replacement',
      body: 'A valid in-archive supersession target.',
      createdBy: 'archive-test',
    }, { now: '2026-08-20T00:00:01.000Z', idFactory: () => 'lifecycle-second' });
    const archive = exportWorkspace(source.db, { workspace }).content;
    const cases: Array<{
      name: string;
      mutate: (entry: Record<string, unknown>) => void;
    }> = [
      {
        name: 'created after updated',
        mutate: (entry) => {
          entry.created_at = '2026-08-20T00:00:03.000Z';
          entry.updated_at = '2026-08-20T00:00:02.000Z';
        },
      },
      {
        name: 'candidate has verified timestamp',
        mutate: (entry) => {
          entry.verified_at = '2026-08-20T00:00:00.000Z';
        },
      },
      {
        name: 'verified lacks verified timestamp',
        mutate: (entry) => {
          entry.status = 'verified';
          entry.verified_at = null;
        },
      },
      {
        name: 'candidate names a supersession target',
        mutate: (entry) => {
          entry.superseded_by = second.id;
        },
      },
      {
        name: 'supersession target is outside archive',
        mutate: (entry) => {
          entry.status = 'superseded';
          entry.superseded_by = 'missing-from-archive';
        },
      },
      {
        name: 'entry supersedes itself',
        mutate: (entry) => {
          entry.status = 'superseded';
          entry.superseded_by = first.id;
        },
      },
    ];

    for (const fixture of cases) {
      const input = path.join(source.directory, `invalid-${fixture.name.replaceAll(' ', '-')}.jsonl`);
      const invalid = rebuildWorkspaceArchive(archive, (payload) => {
        const entry = payload.find((line) => line.type === 'entry' && line.id === first.id);
        assert.ok(entry);
        fixture.mutate(entry);
      });
      await writeFile(input, invalid, 'utf8');
      await assert.rejects(
        importWorkspace(target.db, { input }),
        (error: unknown) => (error as { code?: string }).code === 'VALIDATION_ERROR',
        fixture.name,
      );
      assertArchiveTablesEmpty(target.db);
    }
  } finally {
    source.db.close();
    target.db.close();
  }
});

test('import rejects malformed UTF-8 before checksum handling and database mutation', async () => {
  const source = await database('export-invalid-utf8-source');
  const target = await database('export-invalid-utf8-target');
  const workspace = 'project:archive-invalid-utf8';
  const input = path.join(source.directory, 'invalid-utf8.jsonl');
  try {
    recordEntry(source.db, {
      workspace,
      kind: 'fact',
      title: 'Fatal UTF-8 decoding',
      body: 'The only replacement marker is here: \uFFFD',
    });
    const archiveBytes = Buffer.from(exportWorkspace(source.db, { workspace }).content, 'utf8');
    const replacementBytes = Buffer.from('\uFFFD', 'utf8');
    const replacementIndex = archiveBytes.indexOf(replacementBytes);
    assert.notEqual(replacementIndex, -1);
    assert.equal(archiveBytes.indexOf(replacementBytes, replacementIndex + replacementBytes.length), -1);
    const invalidBytes = Buffer.concat([
      archiveBytes.subarray(0, replacementIndex),
      Buffer.from([0xff]),
      archiveBytes.subarray(replacementIndex + replacementBytes.length),
    ]);
    await writeFile(input, invalidBytes);

    await assert.rejects(
      importWorkspace(target.db, { input }),
      (error: unknown) => (error as { code?: string }).code === 'VALIDATION_ERROR'
        && /UTF-8/iu.test((error as Error).message),
    );
    assertArchiveTablesEmpty(target.db);
  } finally {
    source.db.close();
    target.db.close();
  }
});

test('import accepts only a bound regular input and does not block while rejecting a FIFO', {
  skip: process.platform === 'win32' ? 'POSIX O_NOFOLLOW and O_NONBLOCK contract' : false,
}, async () => {
  const source = await database('export-input-kind-source');
  const target = await database('export-input-kind-target');
  const workspace = 'project:archive-input-kind';
  const archivePath = path.join(source.directory, 'archive.jsonl');
  const symlinkPath = path.join(source.directory, 'archive-link.jsonl');
  const fifoPath = path.join(source.directory, 'archive.fifo');
  try {
    recordEntry(source.db, {
      workspace,
      kind: 'fact',
      title: 'Regular input only',
      body: 'Import must bind a non-symlink regular file before reading.',
    });
    const archive = exportWorkspace(source.db, { workspace }).content;
    await writeFile(archivePath, archive, 'utf8');
    await importWorkspace(target.db, { input: archivePath });
    const baseline = archiveReplayState(target.db);
    await symlink(archivePath, symlinkPath);
    await assert.rejects(
      importWorkspace(target.db, { input: symlinkPath }),
      (error: unknown) => (error as { code?: string }).code === 'VALIDATION_ERROR'
        && /regular file/iu.test((error as Error).message),
    );
    assert.deepEqual(archiveReplayState(target.db), baseline);

    const racedSymlinkPath = path.join(source.directory, 'raced-link.jsonl');
    const racedSymlinkTarget = path.join(source.directory, 'raced-link-target.jsonl');
    await writeFile(racedSymlinkPath, await readFile(archivePath));
    await assert.rejects(
      importWorkspace(target.db, { input: racedSymlinkPath }, {
        afterInputPlanned: async (filePath) => {
          await rename(filePath, racedSymlinkTarget);
          await symlink(racedSymlinkTarget, filePath);
        },
      }),
      (error: unknown) => (error as NodeJS.ErrnoException).code === 'ELOOP',
      'O_NOFOLLOW must reject a symlink installed after the regular-file proof',
    );
    assert.deepEqual(archiveReplayState(target.db), baseline);

    await execFileAsync('mkfifo', [fifoPath]);
    const attempt = importWorkspace(target.db, { input: fifoPath });
    let timeout: NodeJS.Timeout | undefined;
    const outcome = await Promise.race([
      attempt.then(
        (value) => ({ kind: 'fulfilled' as const, value }),
        (error: unknown) => ({ kind: 'rejected' as const, error }),
      ),
      new Promise<{ kind: 'timeout' }>((resolve) => {
        timeout = setTimeout(() => resolve({ kind: 'timeout' }), 1_000);
      }),
    ]);
    if (timeout !== undefined) clearTimeout(timeout);
    if (outcome.kind === 'timeout') {
      const writer = await open(fifoPath, constants.O_WRONLY | constants.O_NONBLOCK);
      await writer.close();
      await attempt.catch(() => undefined);
      assert.fail('import blocked while opening a FIFO');
    }
    assert.equal(outcome.kind, 'rejected');
    if (outcome.kind === 'rejected') {
      assert.equal((outcome.error as { code?: string }).code, 'VALIDATION_ERROR');
      assert.match((outcome.error as Error).message, /regular file/iu);
    }
    assert.deepEqual(archiveReplayState(target.db), baseline);

    const racedFifoPath = path.join(source.directory, 'raced.fifo');
    await writeFile(racedFifoPath, await readFile(archivePath));
    const racedFifoAttempt = importWorkspace(target.db, { input: racedFifoPath }, {
      afterInputPlanned: async (filePath) => {
        await rm(filePath);
        await execFileAsync('mkfifo', [filePath]);
      },
    });
    let racedFifoTimeout: NodeJS.Timeout | undefined;
    const racedFifoOutcome = await Promise.race([
      racedFifoAttempt.then(
        (value) => ({ kind: 'fulfilled' as const, value }),
        (error: unknown) => ({ kind: 'rejected' as const, error }),
      ),
      new Promise<{ kind: 'timeout' }>((resolve) => {
        racedFifoTimeout = setTimeout(() => resolve({ kind: 'timeout' }), 1_000);
      }),
    ]);
    if (racedFifoTimeout !== undefined) clearTimeout(racedFifoTimeout);
    if (racedFifoOutcome.kind === 'timeout') {
      const writer = await open(racedFifoPath, constants.O_WRONLY | constants.O_NONBLOCK);
      await writer.close();
      await racedFifoAttempt.catch(() => undefined);
      assert.fail('import blocked after a FIFO replaced the planned regular file');
    }
    assert.equal(racedFifoOutcome.kind, 'rejected');
    if (racedFifoOutcome.kind === 'rejected') {
      assert.equal((racedFifoOutcome.error as { code?: string }).code, 'VALIDATION_ERROR');
      assert.match((racedFifoOutcome.error as Error).message, /regular file/iu);
    }
    assert.deepEqual(archiveReplayState(target.db), baseline);

    const replacedPath = path.join(source.directory, 'replaced-after-bind.jsonl');
    const displacedPath = path.join(source.directory, 'bound-original.jsonl');
    await writeFile(replacedPath, await readFile(archivePath));
    await assert.rejects(
      importWorkspace(target.db, { input: replacedPath }, {
        afterInputBound: async (filePath) => {
          await rename(filePath, displacedPath);
          await writeFile(filePath, await readFile(displacedPath));
        },
      }),
      (error: unknown) => (error as { code?: string }).code === 'CONFLICT',
      'an exact-byte pathname replacement after descriptor binding must conflict',
    );
    assert.deepEqual(archiveReplayState(target.db), baseline);

    const grownPath = path.join(source.directory, 'grown-after-bind.jsonl');
    await writeFile(grownPath, await readFile(archivePath));
    await assert.rejects(
      importWorkspace(target.db, { input: grownPath }, {
        afterInputBound: (filePath) => appendFile(filePath, 'x', 'utf8'),
      }),
      (error: unknown) => (error as { code?: string }).code === 'CONFLICT',
      'growth after descriptor binding must fail the exact bounded read',
    );
    assert.deepEqual(archiveReplayState(target.db), baseline);

    const mutatedPath = path.join(source.directory, 'mutated-after-read.jsonl');
    await writeFile(mutatedPath, await readFile(archivePath));
    const originalMode = (await stat(mutatedPath)).mode & 0o777;
    await assert.rejects(
      importWorkspace(target.db, { input: mutatedPath }, {
        afterInputRead: async (filePath) => {
          const bytes = await readFile(filePath);
          bytes[0] = bytes[0] === 0x7B ? 0x5B : 0x7B;
          await writeFile(filePath, bytes);
          await chmod(filePath, originalMode ^ 0o100);
        },
      }),
      (error: unknown) => (error as { code?: string }).code === 'CONFLICT',
      'in-place content and metadata mutation after the read must conflict',
    );
    assert.deepEqual(archiveReplayState(target.db), baseline);

    assert.deepEqual(await importWorkspace(target.db, { input: archivePath }), {
      count: 1,
      imported: 0,
      duplicates: 1,
      dryRun: false,
      workspace,
    });
    assert.deepEqual(archiveReplayState(target.db), baseline);
    assert.equal(exportWorkspace(target.db, { workspace }).content, archive);
  } finally {
    source.db.close();
    target.db.close();
  }
});

test('import rejects BOM, duplicate, deep, and malformed-Unicode JSON without changing replay state', async () => {
  const source = await database('export-strict-json-source');
  const target = await database('export-strict-json-target');
  const workspace = 'project:archive-strict-json';
  const validPath = path.join(source.directory, 'valid.jsonl');
  try {
    recordEntry(source.db, {
      workspace,
      kind: 'fact',
      title: 'Strict JSON import boundary',
      body: 'Every JSON layer must be bounded, unique, and well-formed Unicode.',
      scope: { schemaVersion: 1, visibility: 'project', retrievalScope: 'project-only' },
    });
    const archive = exportWorkspace(source.db, { workspace }).content;
    await writeFile(validPath, archive, 'utf8');
    await importWorkspace(target.db, { input: validPath });
    const baseline = archiveReplayState(target.db);

    const replacementPath = path.join(source.directory, 'alias-\uFFFD.jsonl');
    await writeFile(replacementPath, archive, 'utf8');
    await assert.rejects(
      importWorkspace(target.db, { input: path.join(source.directory, 'alias-\uD800.jsonl') }),
      (error: unknown) => (error as { code?: string }).code === 'VALIDATION_ERROR'
        && /well-formed Unicode/iu.test((error as Error).message),
      'a malformed input path must not alias the replacement-character filename',
    );
    assert.deepEqual(archiveReplayState(target.db), baseline);
    for (const [label, input] of [
      ['NUL', `${validPath}\u0000ignored`],
      ['newline', `${validPath}\nignored`],
      ['C1 control', `${validPath}\u0085ignored`],
    ] as const) {
      await assert.rejects(
        importWorkspace(target.db, { input }),
        (error: unknown) => (error as { code?: string }).code === 'VALIDATION_ERROR'
          && /control characters/iu.test((error as Error).message),
        label,
      );
      assert.deepEqual(archiveReplayState(target.db), baseline, label);
    }

    const mutateEntryLine = (
      content: string,
      mutate: (line: string, parsed: Record<string, unknown>) => string,
    ): string => rebuildWorkspaceArchiveLines(content, (payloadLines) => {
      const index = payloadLines.findIndex((line) => {
        try {
          return (JSON.parse(line) as Record<string, unknown>).type === 'entry';
        } catch {
          return false;
        }
      });
      assert.notEqual(index, -1);
      const line = payloadLines[index]!;
      payloadLines[index] = mutate(line, JSON.parse(line) as Record<string, unknown>);
    });

    const duplicateOuterKey = mutateEntryLine(archive, (line) => `{"title":"duplicate",${line.slice(1)}`);
    const overDeepOuterJson = rebuildWorkspaceArchiveLines(archive, (payloadLines) => {
      payloadLines[0] = `${'{"value":'.repeat(MAX_STRICT_JSON_DEPTH + 1)}null${'}'.repeat(MAX_STRICT_JSON_DEPTH + 1)}`;
    });
    const directLoneSurrogate = mutateEntryLine(archive, (line, parsed) => {
      const titleField = `"title":${JSON.stringify(parsed.title)}`;
      assert.equal(line.includes(titleField), true);
      return line.replace(titleField, '"title":"\\ud800"');
    });
    const duplicateNestedKey = rebuildWorkspaceArchive(archive, (payload) => {
      payload.find((line) => line.type === 'entry')!.scope_json = '{"identity":1,"identity":2}';
    });
    const overDeepNestedJson = rebuildWorkspaceArchive(archive, (payload) => {
      payload.find((line) => line.type === 'entry')!.scope_json = `${'{"value":'.repeat(MAX_STRICT_JSON_DEPTH + 1)}null${'}'.repeat(MAX_STRICT_JSON_DEPTH + 1)}`;
    });
    const loneSurrogateNestedKey = rebuildWorkspaceArchive(archive, (payload) => {
      payload.find((line) => line.type === 'entry')!.scope_json = '{"\\ud800":"value"}';
    });
    const loneSurrogateNestedValue = rebuildWorkspaceArchive(archive, (payload) => {
      payload.find((line) => line.type === 'entry')!.scope_json = '{"value":"\\ud800"}';
    });

    const cases: Array<{
      name: string;
      content: string;
      message: RegExp;
      workspaceOverride?: string;
    }> = [
      { name: 'utf8-bom', content: `\uFEFF${archive}`, message: /BOM/iu },
      { name: 'duplicate-outer-key', content: duplicateOuterKey, message: /contains invalid JSON/iu },
      { name: 'over-deep-outer-json', content: overDeepOuterJson, message: /contains invalid JSON/iu },
      { name: 'duplicate-nested-key', content: duplicateNestedKey, message: /must contain valid JSON/iu },
      { name: 'over-deep-nested-json', content: overDeepNestedJson, message: /must contain valid JSON/iu },
      { name: 'direct-lone-surrogate', content: directLoneSurrogate, message: /contains invalid JSON/iu },
      { name: 'lone-surrogate-nested-key', content: loneSurrogateNestedKey, message: /must contain valid JSON/iu },
      { name: 'lone-surrogate-nested-value', content: loneSurrogateNestedValue, message: /must contain valid JSON/iu },
      {
        name: 'lone-surrogate-workspace-override',
        content: archive,
        message: /well-formed Unicode/iu,
        workspaceOverride: 'project:\uD800',
      },
    ];

    for (const fixture of cases) {
      const input = path.join(source.directory, `${fixture.name}.jsonl`);
      await writeFile(input, fixture.content, 'utf8');
      await assert.rejects(
        importWorkspace(target.db, {
          input,
          ...(fixture.workspaceOverride === undefined ? {} : { workspace: fixture.workspaceOverride }),
        }),
        (error: unknown) => (error as { code?: string }).code === 'VALIDATION_ERROR'
          && fixture.message.test((error as Error).message),
        fixture.name,
      );
      assert.deepEqual(archiveReplayState(target.db), baseline, fixture.name);
    }

    assert.deepEqual(await importWorkspace(target.db, { input: validPath }), {
      count: 1,
      imported: 0,
      duplicates: 1,
      dryRun: false,
      workspace,
    });
    assert.deepEqual(archiveReplayState(target.db), baseline);
    assert.equal(exportWorkspace(target.db, { workspace }).content, archive);
  } finally {
    source.db.close();
    target.db.close();
  }
});

test('import enforces exact total-byte, line-byte, and line-count archive bounds', async () => {
  const target = await database('export-archive-bounds');
  const totalPath = path.join(target.directory, 'total-bound.jsonl');
  const linePath = path.join(target.directory, 'line-bound.jsonl');
  const countPath = path.join(target.directory, 'count-bound.jsonl');
  const validationErrorExcept = (excludedMessage: string) => (error: unknown): boolean => {
    const typed = error as { code?: string; message?: string };
    return typed.code === 'VALIDATION_ERROR'
      && typeof typed.message === 'string'
      && !typed.message.includes(excludedMessage);
  };
  const exactBoundError = (message: string) => (error: unknown): boolean => {
    const typed = error as { code?: string; message?: string };
    return typed.code === 'VALIDATION_ERROR'
      && typeof typed.message === 'string'
      && typed.message.includes(message);
  };
  try {
    assert.equal(WORKSPACE_ARCHIVE_MAX_BYTES % WORKSPACE_ARCHIVE_MAX_LINE_BYTES, 0);
    const totalHandle = await open(totalPath, 'w');
    try {
      await totalHandle.truncate(WORKSPACE_ARCHIVE_MAX_BYTES);
      const newline = Buffer.from('\n');
      for (
        let offset = WORKSPACE_ARCHIVE_MAX_LINE_BYTES - 1;
        offset < WORKSPACE_ARCHIVE_MAX_BYTES;
        offset += WORKSPACE_ARCHIVE_MAX_LINE_BYTES
      ) {
        await totalHandle.write(newline, 0, newline.length, offset);
      }
    } finally {
      await totalHandle.close();
    }
    const totalMessage = `${WORKSPACE_ARCHIVE_MAX_BYTES}-byte maximum`;
    await assert.rejects(
      importWorkspace(target.db, { input: totalPath, dryRun: true }),
      validationErrorExcept(totalMessage),
      'an archive at the exact total-byte limit must pass the total-byte gate',
    );
    const grownTotalHandle = await open(totalPath, 'r+');
    try {
      await grownTotalHandle.truncate(WORKSPACE_ARCHIVE_MAX_BYTES + 1);
    } finally {
      await grownTotalHandle.close();
    }
    await assert.rejects(
      importWorkspace(target.db, { input: totalPath, dryRun: true }),
      exactBoundError(totalMessage),
      'an archive one byte above the total-byte limit must fail that gate',
    );

    const lineFixture = Buffer.alloc(WORKSPACE_ARCHIVE_MAX_LINE_BYTES + 2, 0x78);
    lineFixture[WORKSPACE_ARCHIVE_MAX_LINE_BYTES] = 0x0a;
    await writeFile(linePath, lineFixture.subarray(0, WORKSPACE_ARCHIVE_MAX_LINE_BYTES + 1));
    const lineMessage = `${WORKSPACE_ARCHIVE_MAX_LINE_BYTES}-byte maximum`;
    await assert.rejects(
      importWorkspace(target.db, { input: linePath, dryRun: true }),
      validationErrorExcept(lineMessage),
      'a line at the exact byte limit must pass the line-byte gate',
    );
    lineFixture[WORKSPACE_ARCHIVE_MAX_LINE_BYTES] = 0x78;
    lineFixture[WORKSPACE_ARCHIVE_MAX_LINE_BYTES + 1] = 0x0a;
    await writeFile(linePath, lineFixture);
    await assert.rejects(
      importWorkspace(target.db, { input: linePath, dryRun: true }),
      exactBoundError(lineMessage),
      'a line one byte above the byte limit must fail that gate',
    );

    const countFixture = Buffer.from('x\n'.repeat(WORKSPACE_ARCHIVE_MAX_LINES + 1), 'utf8');
    await writeFile(countPath, countFixture.subarray(0, WORKSPACE_ARCHIVE_MAX_LINES * 2));
    const countMessage = `${WORKSPACE_ARCHIVE_MAX_LINES}-line maximum`;
    await assert.rejects(
      importWorkspace(target.db, { input: countPath, dryRun: true }),
      validationErrorExcept(countMessage),
      'an archive at the exact line-count limit must pass the line-count gate',
    );
    await writeFile(countPath, countFixture);
    await assert.rejects(
      importWorkspace(target.db, { input: countPath, dryRun: true }),
      exactBoundError(countMessage),
      'an archive one line above the count limit must fail that gate',
    );

    assertArchiveTablesEmpty(target.db);
  } finally {
    target.db.close();
  }
});

test('export refuses an importer-incompatible overlong record before returning or writing output', async () => {
  const source = await database('export-overlong-record');
  const workspace = 'project:archive-overlong-export';
  const output = path.join(source.directory, 'overlong-export.jsonl');
  const expectedMessage = `${WORKSPACE_ARCHIVE_MAX_LINE_BYTES}-byte maximum`;
  try {
    const entryId = 'overlong-export-entry';
    const title = 'Overlong exported record';
    const body = 'x'.repeat(WORKSPACE_ARCHIVE_MAX_LINE_BYTES);
    const createdAt = '2026-08-20T00:00:00.000Z';
    const contentHash = canonicalEntryRevisionContentHash({
      kind: 'fact', title, body, summary: null, scope: {}, provenance: {}, tags: [],
    });
    source.db.prepare(`
      INSERT INTO entries (
        id, workspace, status, trust_level, confidence, current_revision,
        superseded_by, created_by, created_at, updated_at, verified_at
      ) VALUES (?, ?, 'candidate', 'user_asserted', 1, 1, NULL, 'archive-test', ?, ?, NULL)
    `).run(entryId, workspace, createdAt, createdAt);
    source.db.prepare(`
      INSERT INTO entry_revisions (
        entry_id, workspace, revision, kind, title, body, summary, scope_json,
        provenance_json, content_hash, created_by, created_at
      ) VALUES (?, ?, 1, 'fact', ?, ?, NULL, '{}', '{}', ?, 'archive-test', ?)
    `).run(entryId, workspace, title, body, contentHash, createdAt);
    assert.throws(
      () => exportWorkspace(source.db, { workspace }),
      (error: unknown) => (error as { code?: string; message?: string }).code === 'VALIDATION_ERROR'
        && (error as Error).message.includes(expectedMessage),
    );
    await assert.rejects(
      writeExport(source.db, { workspace, output }),
      (error: unknown) => (error as { code?: string; message?: string }).code === 'VALIDATION_ERROR'
        && (error as Error).message.includes(expectedMessage),
    );
    await assert.rejects(
      readFile(output),
      (error: unknown) => (error as NodeJS.ErrnoException).code === 'ENOENT',
    );
  } finally {
    source.db.close();
  }
});

test('import rejects secret-like content in every archive record category without mutation or echo', async () => {
  const source = await database('export-secret-source');
  const target = await database('export-secret-target');
  const workspace = 'project:archive-secret-scan';
  const secret = `ghp_${'S'.repeat(24)}`;
  try {
    const first = recordEntry(source.db, {
      workspace,
      kind: 'fact',
      title: 'Archive secret scan source',
      body: 'Every persisted archive field is a security boundary.',
      tags: ['safe-tag'],
      scope: { nested: { safe: 'value' } },
      provenance: { type: 'document', reference: 'docs/database.md' },
      createdBy: 'archive-test',
    }, { now: '2026-08-20T00:00:00.000Z', idFactory: () => 'secret-first' });
    const second = recordEntry(source.db, {
      workspace,
      kind: 'fact',
      title: 'Archive secret scan target',
      body: 'Provides a valid link target.',
      createdBy: 'archive-test',
    }, { now: '2026-08-20T00:00:01.000Z', idFactory: () => 'secret-second' });
    linkEntries(source.db, {
      workspace,
      fromEntryId: first.id,
      toEntryId: second.id,
      relation: 'supports',
      actor: 'archive-test',
      now: '2026-08-20T00:00:02.000Z',
    });
    const archive = exportWorkspace(source.db, { workspace }).content;
    const cases: Array<{
      name: string;
      mutate: (payload: Record<string, unknown>[]) => void;
    }> = [
      {
        name: 'manifest and workspace identity',
        mutate: (payload) => {
          const secretWorkspace = `project:${secret}`;
          payload.find((line) => line.type === 'manifest')!.workspace = secretWorkspace;
          for (const entry of payload.filter((line) => line.type === 'entry')) entry.workspace = secretWorkspace;
          for (const audit of payload.filter((line) => line.type === 'audit')) audit.workspace = secretWorkspace;
        },
      },
      {
        name: 'tag value',
        mutate: (payload) => {
          payload.find((line) => line.type === 'tag' && line.entry_id === first.id)!.tag = secret;
          recomputeArchiveEntryHash(payload, first.id);
        },
      },
      {
        name: 'link actor',
        mutate: (payload) => {
          payload.find((line) => line.type === 'link')!.created_by = secret;
        },
      },
      {
        name: 'audit actor',
        mutate: (payload) => {
          payload.find((line) => line.type === 'audit')!.actor = secret;
        },
      },
      {
        name: 'nested audit details',
        mutate: (payload) => {
          payload.find((line) => line.type === 'audit')!.details_json = canonicalJson({ nested: { token: secret } });
        },
      },
      {
        name: 'nested entry scope JSON',
        mutate: (payload) => {
          const entry = payload.find((line) => line.type === 'entry' && line.id === first.id);
          assert.ok(entry);
          entry.scope_json = canonicalJson({ nested: { token: secret } });
          recomputeArchiveEntryHash(payload, first.id);
        },
      },
      {
        name: 'entry provenance JSON',
        mutate: (payload) => {
          const entry = payload.find((line) => line.type === 'entry' && line.id === first.id);
          assert.ok(entry);
          entry.provenance_json = canonicalJson({ type: 'document', reference: secret });
          recomputeArchiveEntryHash(payload, first.id);
        },
      },
    ];

    for (const fixture of cases) {
      const input = path.join(source.directory, `secret-${fixture.name.replaceAll(' ', '-')}.jsonl`);
      await writeFile(input, rebuildWorkspaceArchive(archive, fixture.mutate), 'utf8');
      const before = rowCounts(target.db);
      await assert.rejects(
        importWorkspace(target.db, { input }),
        (error: unknown) => {
          const typed = error as { code?: string; message?: string; details?: unknown };
          assert.equal(typed.code, 'SECURITY_REJECTION', fixture.name);
          assert.equal(
            JSON.stringify({ message: typed.message, details: typed.details }).includes(secret),
            false,
            `${fixture.name} must not echo secret content`,
          );
          return true;
        },
        fixture.name,
      );
      assert.deepEqual(rowCounts(target.db), before, fixture.name);
    }
    assertArchiveTablesEmpty(target.db);
  } finally {
    source.db.close();
    target.db.close();
  }
});

test('import resolves a valid superseded entry regardless of archive entry order', async () => {
  const source = await database('export-supersession-source');
  const oldFirstTarget = await database('export-supersession-old-first');
  const replacementFirstTarget = await database('export-supersession-replacement-first');
  const workspace = 'project:archive-supersession';
  try {
    const oldEntry = recordEntry(source.db, {
      workspace,
      kind: 'decision',
      title: 'Old decision',
      body: 'This decision has a replacement.',
      createdBy: 'archive-test',
    }, { now: '2026-08-20T00:00:00.000Z', idFactory: () => '000-old-entry' });
    const replacement = recordEntry(source.db, {
      workspace,
      kind: 'decision',
      title: 'Replacement decision',
      body: 'This is the current decision.',
      createdBy: 'archive-test',
    }, { now: '2026-08-20T00:00:01.000Z', idFactory: () => '999-replacement-entry' });
    supersedeEntry(source.db, {
      workspace,
      oldEntryId: oldEntry.id,
      replacementEntryId: replacement.id,
      expectedRevision: 1,
      actor: 'archive-test',
      now: '2026-08-20T00:00:02.000Z',
    });

    const archive = exportWorkspace(source.db, { workspace }).content;
    const replacementFirstArchive = rebuildWorkspaceArchive(archive, (payload) => {
      const oldIndex = payload.findIndex((line) => line.type === 'entry' && line.id === oldEntry.id);
      const replacementIndex = payload.findIndex((line) => line.type === 'entry' && line.id === replacement.id);
      assert.notEqual(oldIndex, -1);
      assert.notEqual(replacementIndex, -1);
      [payload[oldIndex], payload[replacementIndex]] = [payload[replacementIndex]!, payload[oldIndex]!];
    });
    const oldFirstPath = path.join(source.directory, 'old-first.jsonl');
    const replacementFirstPath = path.join(source.directory, 'replacement-first.jsonl');
    await writeFile(oldFirstPath, archive, 'utf8');
    await writeFile(replacementFirstPath, replacementFirstArchive, 'utf8');

    for (const [target, input] of [
      [oldFirstTarget, oldFirstPath],
      [replacementFirstTarget, replacementFirstPath],
    ] as const) {
      assert.deepEqual(await importWorkspace(target.db, { input }), {
        count: 2,
        imported: 2,
        duplicates: 0,
        dryRun: false,
        workspace,
      });
      const importedOld = target.db.prepare(
        'SELECT status, superseded_by FROM entries WHERE id = ?',
      ).get<{ status: string; superseded_by: string | null }>(oldEntry.id);
      assert.equal(importedOld?.status, 'superseded');
      assert.equal(importedOld?.superseded_by, replacement.id);
      assert.equal(exportWorkspace(target.db, { workspace }).content, archive);
    }
  } finally {
    source.db.close();
    oldFirstTarget.db.close();
    replacementFirstTarget.db.close();
  }
});

test('import validates a bounded long supersession chain', async () => {
  const source = await database('export-long-supersession-source');
  const target = await database('export-long-supersession-target');
  const workspace = 'project:archive-long-supersession';
  const input = path.join(source.directory, 'long-supersession.jsonl');
  const chainLength = 128;
  try {
    const entries = Array.from({ length: chainLength }, (_, index) => recordEntry(source.db, {
      workspace,
      kind: 'decision',
      title: `Chain decision ${index}`,
      body: `Revision-one decision at chain position ${index}.`,
      createdBy: 'archive-test',
    }, {
      now: new Date(Date.UTC(2026, 7, 20, 0, 0, index)).toISOString(),
      idFactory: () => `chain-${String(index).padStart(3, '0')}`,
    }));
    for (let index = 0; index < entries.length - 1; index += 1) {
      supersedeEntry(source.db, {
        workspace,
        oldEntryId: entries[index]!.id,
        replacementEntryId: entries[index + 1]!.id,
        expectedRevision: 1,
        actor: 'archive-test',
        now: new Date(Date.UTC(2026, 7, 20, 1, 0, index)).toISOString(),
      });
    }
    const archive = exportWorkspace(source.db, { workspace }).content;
    await writeFile(input, archive, 'utf8');

    assert.deepEqual(await importWorkspace(target.db, { input }), {
      count: chainLength,
      imported: chainLength,
      duplicates: 0,
      dryRun: false,
      workspace,
    });
    assert.equal(
      target.db.prepare('SELECT superseded_by FROM entries WHERE id = ?').get<{ superseded_by: string }>(entries[0]!.id)?.superseded_by,
      entries[1]!.id,
    );
    assert.equal(
      target.db.prepare('SELECT status FROM entries WHERE id = ?').get<{ status: string }>(entries.at(-1)!.id)?.status,
      'candidate',
    );
    assert.equal(exportWorkspace(target.db, { workspace }).content, archive);
  } finally {
    source.db.close();
    target.db.close();
  }
});

test('import treats wrong-workspace and metadata-mismatched entry identities as conflicts', async () => {
  const source = await database('export-identity-source');
  const wrongWorkspaceTarget = await database('export-identity-wrong-workspace');
  const idMetadataTarget = await database('export-identity-id-metadata');
  const hashMetadataTarget = await database('export-identity-hash-metadata');
  const workspace = 'project:archive-identity';
  const input = path.join(source.directory, 'identity.jsonl');
  const content = {
    kind: 'fact' as const,
    title: 'Stable archive identity',
    body: 'Content equality alone does not make record metadata equal.',
    createdBy: 'archive-test',
  };
  try {
    recordEntry(source.db, { workspace, ...content }, {
      now: '2026-08-20T00:00:00.000Z',
      idFactory: () => 'shared-archive-entry',
    });
    await writeFile(input, exportWorkspace(source.db, { workspace }).content, 'utf8');

    recordEntry(wrongWorkspaceTarget.db, { workspace: 'project:other-owner', ...content }, {
      now: '2026-08-20T00:00:00.000Z',
      idFactory: () => 'shared-archive-entry',
    });
    recordEntry(idMetadataTarget.db, { workspace, ...content, status: 'verified' }, {
      now: '2026-08-20T00:00:00.000Z',
      idFactory: () => 'shared-archive-entry',
    });
    recordEntry(hashMetadataTarget.db, { workspace, ...content, status: 'verified' }, {
      now: '2026-08-20T00:00:00.000Z',
      idFactory: () => 'different-entry-with-same-hash',
    });

    for (const target of [wrongWorkspaceTarget, idMetadataTarget, hashMetadataTarget]) {
      const before = rowCounts(target.db);
      await assert.rejects(
        importWorkspace(target.db, { input }),
        (error: unknown) => (error as { code?: string }).code === 'CONFLICT',
      );
      assert.deepEqual(rowCounts(target.db), before);
    }
  } finally {
    source.db.close();
    wrongWorkspaceTarget.db.close();
    idMetadataTarget.db.close();
    hashMetadataTarget.db.close();
  }
});

test('import rejects cross-ID content collisions without remapping links or audit events', async () => {
  const source = await database('export-cross-id-source');
  const target = await database('export-cross-id-target');
  const workspace = 'project:archive-cross-id';
  const input = path.join(source.directory, 'cross-id.jsonl');
  const sharedContent = {
    workspace,
    kind: 'fact' as const,
    title: 'Same content, different identity',
    body: 'Content hashes do not authorize identity remapping.',
    createdBy: 'archive-test',
  };
  try {
    const sourceShared = recordEntry(source.db, sharedContent, {
      now: '2026-08-20T00:00:00.000Z',
      idFactory: () => 'source-content-id',
    });
    const sourceRelated = recordEntry(source.db, {
      workspace,
      kind: 'fact',
      title: 'Related archive entry',
      body: 'This row and its relationship must not be partially imported.',
      createdBy: 'archive-test',
    }, {
      now: '2026-08-20T00:00:01.000Z',
      idFactory: () => 'source-related-id',
    });
    linkEntries(source.db, {
      workspace,
      fromEntryId: sourceShared.id,
      toEntryId: sourceRelated.id,
      relation: 'supports',
      actor: 'archive-test',
      now: '2026-08-20T00:00:02.000Z',
    });
    await writeFile(input, exportWorkspace(source.db, { workspace }).content, 'utf8');

    recordEntry(target.db, sharedContent, {
      now: '2026-08-20T00:00:00.000Z',
      idFactory: () => 'target-content-id',
    });
    const before = rowCounts(target.db);
    await assert.rejects(
      importWorkspace(target.db, { input }),
      (error: unknown) => (error as { code?: string }).code === 'CONFLICT',
    );
    assert.deepEqual(rowCounts(target.db), before);
    assert.equal(target.db.prepare('SELECT COUNT(*) AS count FROM entry_links').get<{ count: number }>()?.count, 0);
    assert.equal(target.db.prepare('SELECT 1 AS present FROM entries WHERE id = ?').get(sourceShared.id), undefined);
    assert.equal(target.db.prepare('SELECT 1 AS present FROM entries WHERE id = ?').get(sourceRelated.id), undefined);
  } finally {
    source.db.close();
    target.db.close();
  }
});

test('import rejects existing link and audit identities with different metadata', async () => {
  const source = await database('export-related-identity-source');
  const linkTarget = await database('export-related-link-target');
  const auditTarget = await database('export-related-audit-target');
  const workspace = 'project:archive-related-identity';
  const input = path.join(source.directory, 'related-identities.jsonl');
  try {
    const first = recordEntry(source.db, {
      workspace,
      kind: 'fact',
      title: 'First related entry',
      body: 'Link source.',
      createdBy: 'archive-test',
    }, { now: '2026-08-20T00:00:00.000Z', idFactory: () => 'related-first' });
    const second = recordEntry(source.db, {
      workspace,
      kind: 'fact',
      title: 'Second related entry',
      body: 'Link target.',
      createdBy: 'archive-test',
    }, { now: '2026-08-20T00:00:01.000Z', idFactory: () => 'related-second' });
    linkEntries(source.db, {
      workspace,
      fromEntryId: first.id,
      toEntryId: second.id,
      relation: 'supports',
      actor: 'archive-test',
      now: '2026-08-20T00:00:02.000Z',
    });
    await writeFile(input, exportWorkspace(source.db, { workspace }).content, 'utf8');

    await importWorkspace(linkTarget.db, { input });
    linkTarget.db.prepare(`
      UPDATE entry_links
         SET created_by = 'different-link-actor'
       WHERE from_entry_id = ? AND to_entry_id = ? AND relation = 'supports'
    `).run(first.id, second.id);
    const linkCounts = rowCounts(linkTarget.db);
    for (const dryRun of [true, false]) {
      await assert.rejects(
        importWorkspace(linkTarget.db, { input, dryRun }),
        (error: unknown) => (error as { code?: string }).code === 'CONFLICT',
        `link metadata collision must fail with dryRun=${String(dryRun)}`,
      );
      assert.deepEqual(rowCounts(linkTarget.db), linkCounts);
    }
    assert.equal(
      linkTarget.db.prepare(`
        SELECT created_by FROM entry_links
         WHERE from_entry_id = ? AND to_entry_id = ? AND relation = 'supports'
      `).get<{ created_by: string }>(first.id, second.id)?.created_by,
      'different-link-actor',
    );

    await importWorkspace(auditTarget.db, { input });
    const auditEvent = auditTarget.db.prepare(
      'SELECT event_id FROM audit_events WHERE workspace = ? ORDER BY event_id ASC LIMIT 1',
    ).get<{ event_id: string }>(workspace);
    assert.ok(auditEvent);
    auditTarget.db.prepare("UPDATE audit_events SET actor = 'different-audit-actor' WHERE event_id = ?")
      .run(auditEvent.event_id);
    const auditCounts = rowCounts(auditTarget.db);
    for (const dryRun of [true, false]) {
      await assert.rejects(
        importWorkspace(auditTarget.db, { input, dryRun }),
        (error: unknown) => (error as { code?: string }).code === 'CONFLICT',
        `audit metadata collision must fail with dryRun=${String(dryRun)}`,
      );
      assert.deepEqual(rowCounts(auditTarget.db), auditCounts);
    }
    assert.equal(
      auditTarget.db.prepare('SELECT actor FROM audit_events WHERE event_id = ?').get<{ actor: string }>(auditEvent.event_id)?.actor,
      'different-audit-actor',
    );
  } finally {
    source.db.close();
    linkTarget.db.close();
    auditTarget.db.close();
  }
});

test('export fails closed on cross-workspace link and audit ownership corruption', async () => {
  const linkSource = await database('export-cross-workspace-link');
  const auditSource = await database('export-cross-workspace-audit');
  const workspace = 'project:archive-owner';
  const otherWorkspace = 'project:archive-other-owner';
  try {
    const linkOwned = recordEntry(linkSource.db, {
      workspace,
      kind: 'fact',
      title: 'Link-owned entry',
      body: 'Owned by the exported workspace.',
    }, { idFactory: () => 'link-owned' });
    const linkForeign = recordEntry(linkSource.db, {
      workspace: otherWorkspace,
      kind: 'fact',
      title: 'Link-foreign entry',
      body: 'Owned by another workspace.',
    }, { idFactory: () => 'link-foreign' });
    linkSource.db.prepare(`
      INSERT INTO entry_links (from_entry_id, to_entry_id, relation, created_at, created_by)
      VALUES (?, ?, 'related_to', '2026-08-20T00:00:00.000Z', 'corrupt-fixture')
    `).run(linkOwned.id, linkForeign.id);
    assert.throws(
      () => exportWorkspace(linkSource.db, { workspace }),
      (error: unknown) => (error as { code?: string }).code === 'INTEGRITY_ERROR',
    );

    recordEntry(auditSource.db, {
      workspace,
      kind: 'fact',
      title: 'Audit-owned entry',
      body: 'Owned by the exported workspace.',
    }, { idFactory: () => 'audit-owned' });
    const auditForeign = recordEntry(auditSource.db, {
      workspace: otherWorkspace,
      kind: 'fact',
      title: 'Audit-foreign entry',
      body: 'Owned by another workspace.',
    }, { idFactory: () => 'audit-foreign' });
    auditSource.db.prepare(`
      INSERT INTO audit_events (event_id, entry_id, workspace, operation, actor, details_json, created_at)
      VALUES ('corrupt-audit-owner', ?, ?, 'link', 'corrupt-fixture', '{}', '2026-08-20T00:00:00.000Z')
    `).run(auditForeign.id, workspace);
    assert.throws(
      () => exportWorkspace(auditSource.db, { workspace }),
      (error: unknown) => (error as { code?: string }).code === 'INTEGRITY_ERROR',
    );
  } finally {
    linkSource.db.close();
    auditSource.db.close();
  }
});

test('export maps serializer-invalid stored audit JSON to a fixed integrity error', async () => {
  const source = await database('export-invalid-stored-json');
  const workspace = 'project:archive-invalid-json';
  try {
    const entry = recordEntry(source.db, {
      workspace,
      kind: 'fact',
      title: 'Audit JSON owner',
      body: 'Owns the corrupt audit fixture.',
    }, { idFactory: () => 'audit-json-owner' });
    source.db.prepare(`
      INSERT INTO audit_events (event_id, entry_id, workspace, operation, actor, details_json, created_at)
      VALUES ('corrupt-audit-json', ?, ?, 'record', 'corrupt-fixture', ?, '2026-08-20T00:00:00.000Z')
    `).run(entry.id, workspace, '{}');

    for (const corruption of [
      '{"value":"\\ud800"}',
      `${'{"nested":'.repeat(129)}null${'}'.repeat(129)}`,
    ]) {
      source.db.prepare('UPDATE audit_events SET details_json = ? WHERE event_id = ?')
        .run(corruption, 'corrupt-audit-json');
      assert.throws(
        () => exportWorkspace(source.db, { workspace }),
        (error: unknown) => (error as { code?: string }).code === 'INTEGRITY_ERROR',
      );
    }
  } finally {
    source.db.close();
  }
});

test('export uses one read snapshot and closes it before writeExport installs the file', async () => {
  const source = await database('export-read-snapshot');
  const concurrent = openConnection(source.databasePath);
  const workspace = 'project:archive-read-snapshot';
  const existingPath = path.join(source.directory, 'occupied-export.jsonl');
  try {
    recordEntry(source.db, {
      workspace,
      kind: 'fact',
      title: 'Pre-snapshot entry',
      body: 'This row exists before the export snapshot begins.',
      createdBy: 'archive-test',
    }, {
      now: '2026-08-20T00:00:00.000Z',
      idFactory: () => 'snapshot-before',
    });
    const expectedBeforeMutation = exportWorkspace(source.db, { workspace });
    const hooked = hookedDatabase(source.db, () => {
      recordEntry(concurrent, {
        workspace,
        kind: 'fact',
        title: 'Concurrent entry',
        body: 'This row commits after the first snapshot SELECT.',
        createdBy: 'archive-test',
      }, {
        now: '2026-08-20T00:00:01.000Z',
        idFactory: () => 'snapshot-concurrent',
      });
    });

    const snapshot = exportWorkspace(hooked.database, { workspace });
    assert.equal(snapshot.content, expectedBeforeMutation.content);
    assert.equal(snapshot.count, 1);
    assert.equal(snapshot.content.includes('snapshot-concurrent'), false);
    assert.deepEqual(hooked.events, ['begin', 'entry-select', 'commit']);
    assert.equal(hooked.inTransaction(), false);
    assert.equal(exportWorkspace(source.db, { workspace }).count, 2);

    await writeFile(existingPath, 'preserve-existing-output', 'utf8');
    hooked.events.length = 0;
    await assert.rejects(
      writeExport(hooked.database, { workspace, output: existingPath }),
      (error: unknown) => (error as { code?: string }).code === 'CONFLICT'
        && hooked.inTransaction() === false,
      'the read transaction must be committed before the create-only filesystem install fails',
    );
    assert.deepEqual(hooked.events, ['begin', 'entry-select', 'commit']);
    assert.equal(await readFile(existingPath, 'utf8'), 'preserve-existing-output');
  } finally {
    concurrent.close();
    source.db.close();
  }
});

test('writeExport is create-only and concurrent failure leaves no partial artifacts', async () => {
  const source = await database('export-create-only');
  const workspace = 'project:export-create-only';
  const existingPath = path.join(source.directory, 'existing.jsonl');
  const outputDirectory = path.join(source.directory, 'concurrent-output');
  const concurrentPath = path.join(outputDirectory, 'archive.jsonl');
  try {
    recordEntry(source.db, {
      workspace,
      kind: 'fact',
      title: 'Create-only export',
      body: 'An export must never overwrite an existing path.',
    });
    await writeFile(existingPath, 'preserve-existing-output', 'utf8');
    await assert.rejects(
      writeExport(source.db, { workspace, output: existingPath }),
      (error: unknown) => (error as { code?: string }).code === 'CONFLICT',
    );
    assert.equal(await readFile(existingPath, 'utf8'), 'preserve-existing-output');

    await mkdir(outputDirectory);
    const attempts = await Promise.allSettled([
      writeExport(source.db, { workspace, output: concurrentPath }),
      writeExport(source.db, { workspace, output: concurrentPath }),
    ]);
    assert.equal(attempts.filter((attempt) => attempt.status === 'fulfilled').length, 1);
    assert.equal(attempts.filter((attempt) => attempt.status === 'rejected').length, 1);
    const rejected = attempts.find((attempt) => attempt.status === 'rejected');
    assert.equal(rejected?.status, 'rejected');
    assert.equal((rejected.reason as { code?: string }).code, 'CONFLICT');
    assert.equal(await readFile(concurrentPath, 'utf8'), exportWorkspace(source.db, { workspace }).content);
    assert.deepEqual(await readdir(outputDirectory), ['archive.jsonl']);
  } finally {
    source.db.close();
  }
});

test('doctor reports integrity, migration, FTS, and permissions checks', async () => {
  const data = await database('doctor');
  try {
    const result = await runDoctorWithDatabase(data.databasePath, path.join(data.directory, 'runtime', 'server.json'));
    assert.equal(result.ok, true);
    assert.equal(result.checks.integrity.ok, true);
    assert.equal(result.checks.migrations.ok, true);
    assert.equal(result.checks.fts.ok, true);
    assert.equal(result.checks.permissions.ok, true);
    assert.deepEqual(result.checks.ennoOperations, {
      ok: true,
      count: 0,
      detail: 'staleReceipts=0, staleVerifiers=0, recoveredReceipts=0, recoveredVerifiers=0',
    });
  } finally {
    data.db.close();
  }
});

test('doctor fails closed when the current Enno lease schema is incomplete', async () => {
  const data = await database('doctor-enno-schema');
  try {
    data.db.exec('DROP TABLE enno_verifier_runs');
    const result = await runDoctorWithDatabase(data.databasePath, path.join(data.directory, 'runtime', 'server.json'));
    assert.equal(result.checks.ennoOperations.ok, false);
    assert.equal(result.checks.ennoOperations.count, 1);
    assert.match(result.checks.ennoOperations.detail ?? '', /schema is incomplete/iu);
    assert.equal(result.ok, false);
  } finally {
    data.db.close();
  }
});

test('doctor and ledger inspect detect the same corrupt nudge row without exposing its value', async () => {
  const data = await database('doctor-nudge-integrity');
  const sentinel = 'corrupt-nudge-secret-sentinel';
  try {
    const service = new AgentGatewayService(data.db, { now: () => '2026-08-20T00:00:00.000Z' });
    const opened = service.openRun({
      idempotencyKey: 'doctor-nudge-open',
      request: {
        apiVersion: '1',
        workspace: 'project:doctor-nudge',
        client: { kind: 'doctor-test' },
        task: { title: 'doctor nudge', query: 'doctor nudge', profileHints: { taskType: 'build', target: 'src', expected: 'healthy' } },
        captureProfile: 'standard',
        coverage: { run: 'complete', tool: 'complete', command: 'complete', file: 'complete', approval: 'complete' },
        metadata: {},
      },
    });
    recordNudgeDeliveryInTransaction(data.db, {
      runId: opened.runId,
      policyVersion: 'nudges.v1',
      code: 'UNRESOLVED_FAILURE',
      occurrenceId: 'doctor-nudge-occurrence',
      checkpointId: 'doctor-nudge-checkpoint',
      throughSequence: 0,
      priority: 3,
      evidenceEventIds: [],
      referenceIds: [],
      deliveredAt: '2026-08-20T00:00:00.000Z',
    });
    data.db.exec('PRAGMA ignore_check_constraints = ON');
    data.db.prepare('UPDATE nudge_deliveries SET occurrence_id = ?, evidence_event_ids_json = ? WHERE run_id = ?')
      .run(`${'x'.repeat(257)}${sentinel}`, '[123]', opened.runId);
    data.db.exec('PRAGMA ignore_check_constraints = OFF');

    const ledger = inspectLedger(data.db);
    const doctor = await runDoctorWithDatabase(data.databasePath, path.join(data.directory, 'runtime', 'server.json'));
    assert.equal(ledger.ok, false);
    assert.equal(ledger.checks.nudgeDeliveries.ok, false);
    assert.equal(doctor.ok, false);
    assert.equal(doctor.checks.nudgeDeliveries.ok, false);
    assert.equal(JSON.stringify(ledger).includes(sentinel), false);
    assert.equal(JSON.stringify(doctor).includes(sentinel), false);
  } finally {
    data.db.close();
  }
});

test('runtime reads, ledger inspect, doctor, and archive export reject unsorted nudge IDs consistently', async () => {
  const data = await database('unsorted-nudge-ids');
  try {
    const service = new AgentGatewayService(data.db, { now: () => '2026-08-20T00:00:00.000Z' });
    const opened = service.openRun({
      idempotencyKey: 'unsorted-nudge-open',
      request: {
        apiVersion: '1',
        workspace: 'project:unsorted-nudge-ids',
        client: { kind: 'unsorted-nudge-test' },
        task: { title: 'unsorted nudge', query: 'unsorted nudge', profileHints: { taskType: 'build', target: 'src', expected: 'healthy' } },
        captureProfile: 'standard',
        coverage: { run: 'complete', tool: 'complete', command: 'complete', file: 'complete', approval: 'complete' },
        metadata: {},
      },
    });
    recordNudgeDeliveryInTransaction(data.db, {
      runId: opened.runId,
      policyVersion: 'nudges.v1',
      code: 'UNRESOLVED_FAILURE',
      occurrenceId: 'unsorted-nudge-occurrence',
      checkpointId: 'unsorted-nudge-checkpoint',
      throughSequence: 0,
      priority: 3,
      evidenceEventIds: [],
      referenceIds: ['reference-a', 'reference-z'],
      deliveredAt: '2026-08-20T00:00:00.000Z',
    });
    data.db.prepare('UPDATE nudge_deliveries SET reference_ids_json = ? WHERE run_id = ?')
      .run('["reference-z","reference-a"]', opened.runId);

    assert.throws(
      () => readNudgeHistory(data.db, opened.runId, 'nudges.v1'),
      (error: unknown) => (error as { code?: string }).code === 'INTEGRITY_ERROR',
    );
    const ledger = inspectLedger(data.db);
    assert.equal(ledger.ok, false);
    assert.equal(ledger.checks.nudgeDeliveries.ok, false);
    const doctor = await runDoctorWithDatabase(data.databasePath, path.join(data.directory, 'runtime', 'server.json'));
    assert.equal(doctor.ok, false);
    assert.equal(doctor.checks.nudgeDeliveries.ok, false);
    assert.throws(
      () => exportLedgerArchive(data.db, { workspace: 'project:unsorted-nudge-ids' }),
      (error: unknown) => (error as { code?: string }).code === 'INTEGRITY_ERROR',
    );
  } finally {
    data.db.close();
  }
});

test('doctor preserves both check and database-close failures', async () => {
  const data = await database('doctor-dual-failure');
  const checkFailure = new Error('doctor-check-failure-sentinel');
  const closeFailure = new Error('doctor-close-failure-sentinel');
  try {
    await assert.rejects(runDoctor({
      databasePath: data.databasePath,
      embeddingEnvironment: { KIOKUKO_EMBEDDINGS: 'off' },
    }, {
      openConnection: openDoctorConnectionWithFailures(checkFailure, closeFailure),
    }), (error: unknown) => {
      assert.ok(error instanceof AggregateError);
      assert.equal(error.message, 'Doctor checks failed and closing the database connection also failed');
      assert.deepEqual(error.errors, [checkFailure, closeFailure]);
      return true;
    });
  } finally {
    data.db.close();
  }
});

test('doctor fails closed when the required entries_fts table is absent', async () => {
  const data = await database('doctor-missing-fts');
  try {
    data.db.exec('DROP TABLE entries_fts');

    const result = await runDoctorWithDatabase(
      data.databasePath,
      path.join(data.directory, 'runtime', 'server.json'),
    );

    assert.equal(result.fts5, false);
    assert.equal(result.checks.fts.ok, false);
    assert.equal(result.checks.fts.count, 1);
    assert.match(result.checks.fts.detail ?? '', /present=false/u);
    assert.equal(result.ok, false);
  } finally {
    data.db.close();
  }
});

test('doctor uses canonical locale-independent tag ordering for revision hashes', async () => {
  const data = await database('doctor-revision-hash-tags');
  try {
    recordEntry(data.db, {
      workspace: 'project:doctor-hash-tags',
      kind: 'fact',
      title: 'Canonical tag ordering',
      body: 'Mixed-case tags must hash consistently.',
      tags: ['MCP', 'agent-checkpoint', 'context'],
    });

    const result = await runDoctorWithDatabase(data.databasePath, path.join(data.directory, 'runtime', 'server.json'));

    assert.equal(result.checks.revisionHashes.ok, true);
    assert.equal(result.checks.revisionHashes.count, 0);
  } finally {
    data.db.close();
  }
});

test('doctor adds content-free ledger and stale runtime findings', async () => {
  const data = await database('doctor-ledger-runtime');
  const runtimeHome = path.join(data.directory, 'doctor-runtime');
  const runtimeDescriptorPath = path.join(runtimeHome, 'server.json');
  const secretToken = 'b'.repeat(64);
  try {
    const service = new AgentGatewayService(data.db, { now: () => '2026-08-20T00:00:00.000Z' });
    const opened = service.openRun({
      idempotencyKey: 'doctor-open',
      request: {
        apiVersion: '1', workspace: 'project:doctor', client: { kind: 'doctor-test' },
        task: { title: 'doctor', query: 'doctor', profileHints: { taskType: 'build', target: 'src', expected: 'healthy' } },
        captureProfile: 'standard', coverage: { run: 'complete', tool: 'complete', command: 'complete', file: 'complete', approval: 'complete' }, metadata: {},
      },
    });
    data.db.prepare("UPDATE ledger_events SET event_hash = '0' WHERE run_id = ? AND sequence = 1").run(opened.runId);
    await writeRuntimeDescriptor(runtimeDescriptorPath, createRuntimeDescriptor({
      databasePath: data.databasePath,
      baseUrl: 'http://127.0.0.1:1',
      pid: 999999,
      instanceId: '123e4567-e89b-12d3-a456-426614174198',
      capabilityToken: secretToken,
    }));
    const result = await runDoctor({ databasePath: data.databasePath, runtimeDescriptorPath });
    assert.equal(result.ok, false);
    assert.equal(result.checks.ledger.ok, false);
    assert.equal(result.checks.runtime.ok, false);
    const serialized = JSON.stringify(result);
    assert.equal(serialized.includes(data.databasePath), false);
    assert.equal(serialized.includes(secretToken), false);
    assert.equal(serialized.includes(runtimeHome), false);
  } finally {
    await rm(runtimeHome, { recursive: true, force: true });
    data.db.close();
  }
});


async function runDoctorWithDatabase(databasePath: string, runtimeDescriptorPath?: string) {
  const previous = process.env.KIOKUKO_DATABASE;
  process.env.KIOKUKO_DATABASE = databasePath;
  try {
    return await runDoctor({ databasePath, ...(runtimeDescriptorPath === undefined ? {} : { runtimeDescriptorPath }) });
  } finally {
    if (previous === undefined) delete process.env.KIOKUKO_DATABASE;
    else process.env.KIOKUKO_DATABASE = previous;
  }
}

test('backup serializes the read-only source and creates a readable copy', async () => {
  const source = await database('backup');
  const backupPath = path.join(source.directory, 'backup.sqlite3');
  try {
    recordEntry(source.db, { workspace: 'project:backup', kind: 'reference', title: 'Backup', body: 'Consistent snapshot' });
    const result = await sourceBackup(source.databasePath, backupPath);
    assert.equal(result.output, backupPath);
    const backup = openConnection(backupPath);
    try {
      assert.equal(backup.prepare('PRAGMA integrity_check').get<{ integrity_check: string }>()?.integrity_check, 'ok');
      assert.equal(backup.prepare('SELECT COUNT(*) AS count FROM entries').get<{ count: number }>()?.count, 1);
    } finally {
      backup.close();
    }
  } finally {
    source.db.close();
  }
});

async function sourceBackup(databasePath: string, output: string) {
  const previous = process.env.KIOKUKO_DATABASE;
  process.env.KIOKUKO_DATABASE = databasePath;
  try {
    return await createBackup(output, databasePath);
  } finally {
    if (previous === undefined) delete process.env.KIOKUKO_DATABASE;
    else process.env.KIOKUKO_DATABASE = previous;
  }
}
