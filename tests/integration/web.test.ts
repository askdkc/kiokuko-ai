import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readdir, stat } from 'node:fs/promises';
import { createConnection, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { initializeDatabase } from '../../src/commands/init.js';
import type { SqliteDatabase } from '../../src/db/adapter.js';
import { openConnection } from '../../src/db/connection.js';
import { recordEntry } from '../../src/memory/entries.js';
import { registerRepositoryAndLocation } from '../../src/repository/binding.js';
import { startWebServer } from '../../src/web/server.js';

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

async function webSession(baseUrl: string): Promise<string> {
  const response = await fetch(baseUrl);
  const cookie = response.headers.get('set-cookie')?.split(';', 1)[0];
  if (!cookie?.startsWith('kiokuko_ui_session=')) throw new Error('UI session cookie was not issued');
  return cookie;
}

async function webFetch(baseUrl: string, pathname: string, options: RequestInit = {}): Promise<Response> {
  const cookie = await webSession(baseUrl);
  const headers = new Headers(options.headers);
  headers.set('cookie', cookie);
  return fetch(`${baseUrl}${pathname}`, { ...options, headers });
}

async function connectRawSocket(port: number): Promise<Socket> {
  return new Promise<Socket>((resolve, reject) => {
    const socket = createConnection({ host: '127.0.0.1', port });
    const onError = (error: Error) => {
      socket.destroy();
      reject(error);
    };
    socket.once('error', onError);
    socket.once('connect', () => {
      socket.off('error', onError);
      resolve(socket);
    });
  });
}

function readRawResponse(socket: Socket): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const chunks: Buffer[] = [];
    const onData = (chunk: Buffer | string) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    const onEnd = () => {
      cleanup();
      resolve(Buffer.concat(chunks).toString('utf8'));
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const cleanup = () => {
      socket.off('data', onData);
      socket.off('end', onEnd);
      socket.off('error', onError);
    };
    socket.on('data', onData);
    socket.once('end', onEnd);
    socket.once('error', onError);
  });
}

async function fixture() {
  const directory = await mkdtemp(path.join(tmpdir(), 'kiokuko-web-'));
  const databasePath = path.join(directory, 'kiokuko-ai.sqlite');
  await initializeDatabase({ databasePath });
  const database = openConnection(databasePath);
  const repositoryRoot = path.join(directory, 'repo');
  await mkdir(repositoryRoot, { recursive: true });
  registerRepositoryAndLocation(database, {
    repositoryId: 'repo_web_test',
    workspace: 'project:web-test',
    displayName: 'web-test',
    canonicalRoot: repositoryRoot,
    remoteFingerprint: null,
    bindingSchemaVersion: 1,
    agentTemplateVersion: 1,
  });
  const candidate = recordEntry(database, {
    workspace: 'project:web-test',
    kind: 'decision',
    title: '編集前',
    body: 'ブラウザから変更する本文',
    tags: ['bot:builder', 'web'],
  });
  const verified = recordEntry(database, {
    workspace: 'project:web-test',
    kind: 'fact',
    status: 'verified',
    title: '変更禁止',
    body: 'verified content',
    tags: ['bot:reviewer'],
  });
  database.close();
  return { directory, databasePath, candidate, verified };
}

test('startWebServer preserves its handle and health and operator UI routes', async () => {
  const data = await fixture();
  const web = await startWebServer({ databasePath: data.databasePath, host: '127.0.0.1', port: 0, httpOptions: { runtimeDirectory: path.join(data.directory, 'runtime') } });
  try {
    assert.equal(web.server.listening, true);
    assert.match(web.url, /^http:\/\/127\.0\.0\.1:\d+$/);

    const health = await fetch(`${web.url}/api/health`);
    assert.equal(health.status, 200);
    assert.deepEqual(await health.json(), { ok: true });

    const ui = await fetch(web.url);
    assert.equal(ui.status, 200);
    assert.match(ui.headers.get('content-type') ?? '', /^text\/html/);
    assert.match(await ui.text(), /<title>Kiokuko Web<\/title>/);
  } finally {
    await web.close();
  }
  assert.equal(web.server.listening, false);
});

test('startWebServer rejects non-loopback hosts before listening', async () => {
  const data = await fixture();
  await assert.rejects(
    startWebServer({ databasePath: data.databasePath, host: '0.0.0.0', port: 0, httpOptions: { runtimeDirectory: path.join(data.directory, 'runtime') } }),
    /loopback/i,
  );
});

test('web filters by workspace, type, and cross-genre tags and supports candidate editing', async () => {
  const data = await fixture();
  const web = await startWebServer({ databasePath: data.databasePath, host: '127.0.0.1', port: 0, httpOptions: { runtimeDirectory: path.join(data.directory, 'runtime') } });
  try {
    const workspaces = await webFetch(web.url, '/api/workspaces').then((response) => response.json()) as { workspaces: Array<{ workspace: string }> };
    assert.deepEqual(workspaces.workspaces.map((item) => item.workspace), ['project:web-test']);

    const filtered = await webFetch(web.url, '/api/entries?workspace=project%3Aweb-test&kind=decision').then((response) => response.json()) as { entries: Array<{ id: string; kind: string }> };
    assert.deepEqual(filtered.entries.map((entry) => entry.id), [data.candidate.id]);
    assert.equal(filtered.entries[0]?.kind, 'decision');

    const crossGenre = await webFetch(web.url, '/api/entries?workspace=project%3Aweb-test&tag=web').then((response) => response.json()) as { entries: Array<{ id: string; kind: string }> };
    assert.deepEqual(crossGenre.entries.map((entry) => entry.id), [data.candidate.id]);

    const tags = await webFetch(web.url, '/api/tags?workspace=project%3Aweb-test').then((response) => response.json()) as { tags: Array<{ tag: string; count: number }> };
    assert.deepEqual(tags.tags, [
      { tag: 'bot:builder', count: 1 },
      { tag: 'bot:reviewer', count: 1 },
      { tag: 'web', count: 1 },
    ]);

    const update = await webFetch(web.url, `/api/entries/${data.candidate.id}?workspace=project%3Aweb-test`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        expectedRevision: 1,
        kind: 'decision',
        title: '編集後',
        body: 'Web UIで更新済み',
        summary: '要約',
        scope: {},
        provenance: {},
        tags: ['edited'],
      }),
    });
    assert.equal(update.status, 200);
    const updated = await update.json() as { entry: { title: string; body: string; revision: number; tags: string[] } };
    assert.equal(updated.entry.title, '編集後');
    assert.equal(updated.entry.body, 'Web UIで更新済み');
    assert.equal(updated.entry.revision, 2);
    assert.deepEqual(updated.entry.tags, ['edited']);
  } finally {
    await web.close();
  }
});

test('web memory recall returns federated origin and selection metadata', async () => {
  const data = await fixture();
  const web = await startWebServer({ databasePath: data.databasePath, host: '127.0.0.1', port: 0, httpOptions: { runtimeDirectory: path.join(data.directory, 'runtime') } });
  try {
    const response = await webFetch(web.url, '/api/memory/recall?workspace=project%3Aweb-test&q=web');
    const raw = await response.text();
    assert.equal(response.status, 200, raw);
    const body = JSON.parse(raw) as { combined?: { items: Array<{ id: string; origin: string; selectionReasons: string[] }> } };
    assert.ok(body.combined, raw);
    assert.equal(body.combined.items[0]?.id, data.candidate.id, raw);
    assert.equal(body.combined?.items[0]?.origin, 'project');
    assert.ok(body.combined?.items[0]?.selectionReasons.includes('project_origin'));
  } finally {
    await web.close();
  }
});

test('startWebServer composes one shared database lifetime and keeps its operator handle projection', async () => {
  const data = await fixture();
  const runtimeDirectory = path.join(data.directory, 'runtime');
  const descriptorPath = path.join(runtimeDirectory, 'server.json');
  let opened = 0;
  let initialized = 0;
  let closed = 0;
  const web = await startWebServer({
    databasePath: data.databasePath,
    host: '127.0.0.1',
    port: 0,
    httpOptions: {
      runtimeDirectory,
      descriptorPath,
      instanceId: '123e4567-e89b-12d3-a456-426614174120',
      capabilityToken: 'a'.repeat(64),
      initializeDatabase: async (options) => {
        initialized += 1;
        assert.equal(options.databasePath, data.databasePath);
        await initializeDatabase(options);
      },
      openDatabase: () => {
        opened += 1;
        const primary = openConnection(data.databasePath);
        const adapter = {
          filePath: primary.filePath,
          exec: primary.exec.bind(primary),
          prepare: primary.prepare.bind(primary),
          close: () => {
            closed += 1;
            primary.close();
          },
        } satisfies SqliteDatabase;
        return adapter;
      },
    },
  });
  try {
    assert.deepEqual(Object.keys(web).sort(), ['close', 'server', 'url']);
    assert.equal(opened, 1);
    assert.equal(initialized, 1);
    const response = await webFetch(web.url, '/api/workspaces');
    assert.equal(response.status, 200);
    const update = await webFetch(web.url, `/api/entries/${data.candidate.id}?workspace=project%3Aweb-test`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        expectedRevision: 1,
        kind: 'decision',
        title: '単一接続',
        body: 'shared primary database',
        summary: null,
        scope: {},
        provenance: {},
        tags: ['shared'],
      }),
    });
    assert.equal(update.status, 200);
    assert.equal(opened, 1);
  } finally {
    await web.close();
  }
  assert.equal(closed, 1);
});

test('operator mutations admitted before close drain through the shared queue and new mutations are rejected', async () => {
  const data = await fixture();
  const runtimeDirectory = path.join(data.directory, 'runtime');
  const descriptorPath = path.join(runtimeDirectory, 'server.json');
  let opened = 0;
  let closed = 0;
  const web = await startWebServer({
    databasePath: data.databasePath,
    host: '127.0.0.1',
    port: 0,
    httpOptions: {
      runtimeDirectory,
      descriptorPath,
      instanceId: '123e4567-e89b-12d3-a456-426614174121',
      capabilityToken: 'b'.repeat(64),
      openDatabase: () => {
        opened += 1;
        const primary = openConnection(data.databasePath);
        return {
          filePath: primary.filePath,
          exec: primary.exec.bind(primary),
          prepare: primary.prepare.bind(primary),
          close: () => {
            closed += 1;
            primary.close();
          },
        } satisfies SqliteDatabase;
      },
      initializeDatabase,
    },
  });
  const uiCookie = await webSession(web.url);
  const body = JSON.stringify({
    expectedRevision: 1,
    kind: 'decision',
    title: 'shutdown後も保存',
    body: '受理済みのlegacy mutation',
    summary: null,
    scope: {},
    provenance: {},
    tags: ['drained'],
  });
  const partialBody = body.slice(0, -1);
  const target = `/api/entries/${encodeURIComponent(data.candidate.id)}?workspace=project%3Aweb-test`;
  const webAuthority = new URL(web.url).host;
  const requestAdmitted = deferred<void>();
  let socket: Socket | undefined;
  let closePromise: Promise<void> | undefined;
  try {
    web.server.once('request', () => requestAdmitted.resolve());
    socket = await connectRawSocket(Number(new URL(web.url).port));
    const responsePromise = readRawResponse(socket);
    socket.write([
      `PUT ${target} HTTP/1.1`,
      `Host: ${webAuthority}`,
      'Content-Type: application/json',
      `Cookie: ${uiCookie}`,
      `Content-Length: ${Buffer.byteLength(body)}`,
      'Connection: close',
      '',
      partialBody,
    ].join('\r\n'));
    await requestAdmitted.promise;

    closePromise = web.close();
    assert.equal(opened, 1);
    assert.equal(closed, 0);
    assert.equal((await stat(descriptorPath)).isFile(), true);
    await assert.rejects(
      () => fetch(`${web.url}${target}`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body,
      }),
    );

    socket.end(body.slice(partialBody.length));
    const responseText = await responsePromise;
    assert.equal(Number.parseInt(/^HTTP\/\d\.\d (\d+)/.exec(responseText)?.[1] ?? '', 10), 200);
    assert.match(responseText, /shutdown後も保存/);
    await closePromise;
    assert.equal(closed, 1);
    await assert.rejects(() => stat(descriptorPath), (error: unknown) => error instanceof Error && 'code' in error && error.code === 'ENOENT');
    assert.deepEqual((await readdir(runtimeDirectory)).filter((name) => name.endsWith('.lock')), []);
  } finally {
    socket?.destroy();
    await closePromise?.catch(() => undefined);
    if (closed === 0) await web.close().catch(() => undefined);
  }
});

test('web refuses direct edits to verified entries', async () => {
  const data = await fixture();
  const web = await startWebServer({ databasePath: data.databasePath, host: '127.0.0.1', port: 0, httpOptions: { runtimeDirectory: path.join(data.directory, 'runtime') } });
  try {
    const response = await webFetch(web.url, `/api/entries/${data.verified.id}?workspace=project%3Aweb-test`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        expectedRevision: 1,
        kind: 'fact',
        title: '不正な更新',
        body: 'must be rejected',
        summary: null,
        scope: {},
        provenance: {},
        tags: [],
      }),
    });
    assert.equal(response.status, 409);
    const body = await response.json() as { error: { code: string } };
    assert.equal(body.error.code, 'CONFLICT');
  } finally {
    await web.close();
  }
});
