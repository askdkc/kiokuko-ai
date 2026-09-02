import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { initializeDatabase } from '../../src/commands/init.js';
import { openConnection } from '../../src/db/connection.js';
import { recordEntry } from '../../src/memory/entries.js';
import { startWebServer } from '../../src/web/server.js';

async function session(baseUrl: string): Promise<string> {
  const response = await fetch(baseUrl);
  const cookie = response.headers.get('set-cookie')?.split(';', 1)[0];
  if (!cookie?.startsWith('kiokuko_ui_session=')) throw new Error('UI session cookie was not issued');
  return cookie;
}

async function webFetch(baseUrl: string, pathname: string, options: RequestInit = {}): Promise<Response> {
  const headers = new Headers(options.headers);
  headers.set('cookie', await session(baseUrl));
  return fetch(`${baseUrl}${pathname}`, { ...options, headers });
}

async function fixture() {
  const directory = await mkdtemp(path.join(tmpdir(), 'kiokuko-web-memory-revisions-'));
  const databasePath = path.join(directory, 'kiokuko-ai.sqlite');
  await initializeDatabase({ databasePath });
  const database = openConnection(databasePath);
  const entry = recordEntry(database, {
    workspace: 'project:web-revisions',
    kind: 'reference',
    title: 'PostgreSQL',
    body: 'PostgreSQL PGroonga',
    tags: ['postgresql'],
  });
  database.close();
  return { databasePath, entry };
}

test('Web memory uses only the current immutable revision for editing, filters, tags, and search', async () => {
  const data = await fixture();
  const web = await startWebServer({ databasePath: data.databasePath, host: '127.0.0.1', port: 0, httpOptions: { runtimeDirectory: path.join(path.dirname(data.databasePath), 'runtime') } });
  try {
    const workspaceResponse = await webFetch(web.url, '/api/workspaces');
    assert.equal(workspaceResponse.status, 200);
    assert.deepEqual((await workspaceResponse.json() as { workspaces: Array<{ workspace: string }> }).workspaces.map((item) => item.workspace), ['project:web-revisions']);

    const detail = await webFetch(web.url, `/api/entries/${data.entry.id}?workspace=project%3Aweb-revisions`).then((response) => response.json()) as { entry: { revision: number; title: string } };
    assert.deepEqual({ revision: detail.entry.revision, title: detail.entry.title }, { revision: 1, title: 'PostgreSQL' });

    const firstSearch = await webFetch(web.url, '/api/entries?workspace=project%3Aweb-revisions&q=PGroonga').then((response) => response.json()) as { entries: Array<{ id: string }> };
    assert.deepEqual(firstSearch.entries.map((item) => item.id), [data.entry.id]);

    const update = await webFetch(web.url, `/api/entries/${data.entry.id}?workspace=project%3Aweb-revisions`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        expectedRevision: 1,
        kind: 'lesson',
        title: 'SQLite',
        body: 'SQLite FTS5 trigram',
        summary: null,
        scope: {},
        provenance: {},
        tags: ['sqlite'],
      }),
    });
    assert.equal(update.status, 200);
    const updated = await update.json() as { entry: { revision: number; kind: string; title: string; body: string; tags: string[] } };
    assert.deepEqual(updated.entry, {
      ...updated.entry,
      revision: 2,
      kind: 'lesson',
      title: 'SQLite',
      body: 'SQLite FTS5 trigram',
      tags: ['sqlite'],
    });

    const editedDetail = await webFetch(web.url, `/api/entries/${data.entry.id}?workspace=project%3Aweb-revisions`).then((response) => response.json()) as { entry: { revision: number; body: string } };
    assert.deepEqual({ revision: editedDetail.entry.revision, body: editedDetail.entry.body }, { revision: 2, body: 'SQLite FTS5 trigram' });

    for (const [query, expected] of [['PGroonga', 0], ['trigram', 1]] as const) {
      const result = await webFetch(web.url, `/api/entries?workspace=project%3Aweb-revisions&q=${query}`).then((response) => response.json()) as { entries: unknown[] };
      assert.equal(result.entries.length, expected, `search query ${query}`);
    }
    for (const [parameter, expected] of [['kind=reference', 0], ['kind=lesson', 1], ['tag=postgresql', 0], ['tag=sqlite', 1]] as const) {
      const result = await webFetch(web.url, `/api/entries?workspace=project%3Aweb-revisions&${parameter}`).then((response) => response.json()) as { entries: unknown[] };
      assert.equal(result.entries.length, expected, `filter ${parameter}`);
    }
    const tags = await webFetch(web.url, '/api/tags?workspace=project%3Aweb-revisions').then((response) => response.json()) as { tags: Array<{ tag: string; count: number }> };
    assert.deepEqual(tags.tags, [{ tag: 'sqlite', count: 1 }]);

    const stale = await webFetch(web.url, `/api/entries/${data.entry.id}?workspace=project%3Aweb-revisions`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ expectedRevision: 1, kind: 'lesson', title: 'stale', body: 'stale', tags: [] }),
    });
    assert.equal(stale.status, 409);
  } finally {
    await web.close();
  }

  const database = openConnection(data.databasePath);
  try {
    assert.deepEqual(database.prepare('SELECT revision FROM entry_revisions WHERE entry_id = ? ORDER BY revision').all<{ revision: number }>(data.entry.id).map((row) => row.revision), [1, 2]);
    assert.deepEqual(database.prepare('PRAGMA foreign_key_check').all(), []);
    assert.equal(database.prepare('PRAGMA integrity_check').get<{ integrity_check: string }>()?.integrity_check, 'ok');
  } finally {
    database.close();
  }
});

test('Web JSON mutations fail closed on bytes, syntax, media type, and closed body schemas', async () => {
  const data = await fixture();
  const web = await startWebServer({ databasePath: data.databasePath, host: '127.0.0.1', port: 0, httpOptions: { runtimeDirectory: path.join(path.dirname(data.databasePath), 'runtime') } });
  const cookie = await session(web.url);
  const target = `/api/entries/${data.entry.id}?workspace=project%3Aweb-revisions`;
  const validUpdate = JSON.stringify({
    expectedRevision: 1,
    kind: 'lesson',
    title: 'must not persist',
    body: 'must not persist',
    summary: null,
    scope: {},
    provenance: {},
    tags: [],
  });
  const cases: Array<{ name: string; contentType?: string; body?: BodyInit }> = [
    { name: 'invalid UTF-8 bytes', contentType: 'application/json', body: Uint8Array.from([0xff]) },
    { name: 'UTF-8 BOM', contentType: 'application/json', body: Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(validUpdate)]) },
    { name: 'duplicate expectedRevision', contentType: 'application/json', body: '{"expectedRevision":999,"expectedRevision":1,"kind":"lesson","title":"forged revision","body":"must not persist","summary":null,"scope":{},"provenance":{},"tags":[]}' },
    { name: 'duplicate nested scope key', contentType: 'application/json', body: '{"expectedRevision":1,"kind":"lesson","title":"forged scope","body":"must not persist","summary":null,"scope":{"identity":"first","identity":"last"},"provenance":{},"tags":[]}' },
    { name: 'non-finite nested number', contentType: 'application/json', body: '{"expectedRevision":1,"kind":"lesson","title":"non-finite","body":"must not persist","summary":null,"scope":{"weight":1e400},"provenance":{},"tags":[]}' },
    { name: 'unknown entry-update field', contentType: 'application/json', body: validUpdate.slice(0, -1) + ',"unexpected":true}' },
    { name: 'array body', contentType: 'application/json', body: '[]' },
    { name: 'empty body', contentType: 'application/json' },
    { name: 'absent media type', body: Uint8Array.from(Buffer.from(validUpdate)) },
    { name: 'wrong media type', contentType: 'text/plain', body: validUpdate },
    { name: 'structured JSON suffix', contentType: 'application/merge-patch+json', body: validUpdate },
    { name: 'media type parameter', contentType: 'application/json; charset=utf-8', body: validUpdate },
  ];

  try {
    for (const invalid of cases) {
      const headers = new Headers({ cookie });
      if (invalid.contentType !== undefined) headers.set('content-type', invalid.contentType);
      const response = await fetch(`${web.url}${target}`, {
        method: 'PUT',
        headers,
        ...(invalid.body === undefined ? {} : { body: invalid.body }),
      });
      assert.equal(response.status, 400, invalid.name);
      assert.deepEqual(await response.json(), {
        error: { code: 'VALIDATION_ERROR', message: 'Request is invalid', details: {} },
      }, invalid.name);
      const detail = await fetch(`${web.url}${target}`, { headers: { cookie } }).then((value) => value.json()) as { entry: { revision: number; kind: string; title: string; body: string; scope: Record<string, unknown> } };
      assert.deepEqual(detail.entry, {
        ...detail.entry,
        revision: 1,
        kind: 'reference',
        title: 'PostgreSQL',
        body: 'PostgreSQL PGroonga',
        scope: {},
      }, `${invalid.name} must not mutate the entry`);
    }

    const unknownCuratorField = await fetch(`${web.url}/api/curator/globalize`, {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({
        workspace: 'project:web-revisions',
        entryId: data.entry.id,
        expectedRevision: 1,
        actor: 'web-contract-test',
        unexpected: true,
      }),
    });
    assert.equal(unknownCuratorField.status, 400);
    assert.deepEqual(await unknownCuratorField.json(), {
      error: { code: 'VALIDATION_ERROR', message: 'Request is invalid', details: {} },
    });
  } finally {
    await web.close();
  }

  const database = openConnection(data.databasePath);
  try {
    assert.deepEqual(database.prepare('SELECT revision FROM entry_revisions WHERE entry_id = ? ORDER BY revision').all<{ revision: number }>(data.entry.id).map((row) => row.revision), [1]);
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM entries WHERE workspace = 'global'").get<{ count: number }>()?.count, 0);
  } finally {
    database.close();
  }
});

test('Web JSON parsing does not misclassify unexpected parser failures as request validation', async () => {
  const data = await fixture();
  const web = await startWebServer({ databasePath: data.databasePath, host: '127.0.0.1', port: 0, httpOptions: { runtimeDirectory: path.join(path.dirname(data.databasePath), 'runtime') } });
  const cookie = await session(web.url);
  const originalParse = JSON.parse;
  const sentinel = 'private-parser-programming-error';
  const body = JSON.stringify({
    expectedRevision: 1,
    kind: 'lesson',
    title: 'must not persist',
    body: 'must not persist',
    summary: null,
    scope: {},
    provenance: {},
    tags: [],
  });
  try {
    JSON.parse = (() => { throw new Error(sentinel); }) as typeof JSON.parse;
    const response = await fetch(`${web.url}/api/entries/${data.entry.id}?workspace=project%3Aweb-revisions`, {
      method: 'PUT',
      headers: { cookie, 'content-type': 'application/json' },
      body,
    });
    const responseText = await response.text();
    assert.equal(response.status, 500);
    assert.equal(responseText.includes(sentinel), false);
    assert.deepEqual(originalParse(responseText), {
      error: { code: 'INTEGRITY_ERROR', message: 'Unexpected server error', details: {} },
    });

    const cursor = Buffer.from('[1,0,null,"source","slug","provider","skill"]', 'utf8').toString('base64url');
    const cursorResponse = await fetch(`${web.url}/api/skills?cursor=${cursor}`, { headers: { cookie } });
    const cursorResponseText = await cursorResponse.text();
    assert.equal(cursorResponse.status, 500);
    assert.equal(cursorResponseText.includes(sentinel), false);
    assert.deepEqual(originalParse(cursorResponseText), {
      error: { code: 'INTEGRITY_ERROR', message: 'Unexpected server error', details: {} },
    });
  } finally {
    JSON.parse = originalParse;
    await web.close();
  }

  const database = openConnection(data.databasePath);
  try {
    assert.deepEqual(database.prepare('SELECT revision FROM entry_revisions WHERE entry_id = ? ORDER BY revision').all<{ revision: number }>(data.entry.id).map((row) => row.revision), [1]);
  } finally {
    database.close();
  }
});
