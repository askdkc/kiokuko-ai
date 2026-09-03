import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { initializeDatabase } from '../../src/commands/init.js';
import { openConnection } from '../../src/db/connection.js';
import { LedgerStore } from '../../src/ledger/store.js';
import { TaskRunService } from '../../src/task-run/service.js';
import { startWebServer } from '../../src/web/server.js';

const capabilityToken = 'f'.repeat(64);
const workspace = 'project:web-run-inspection';
const createdAt = '2026-08-20T00:00:00.000Z';

async function sessionCookie(baseUrl: string): Promise<string> {
  const response = await fetch(baseUrl);
  const cookie = response.headers.get('set-cookie')?.split(';', 1)[0];
  if (!cookie?.startsWith('kiokuko_ui_session=')) throw new Error('UI session cookie was not issued');
  return cookie;
}

test('operator UI reads OpenCode task runs directly without exposing the removed Agent API', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'kiokuko-web-run-'));
  const databasePath = path.join(directory, 'data.sqlite3');
  await initializeDatabase({ databasePath });
  const database = openConnection(databasePath);
  const service = new TaskRunService(database, {
    now: () => createdAt,
    runIdFactory: () => 'web-run-1',
    sessionIdFactory: () => 'web-intake-1',
    eventIdFactory: (() => { let index = 0; return () => `web-event-${++index}`; })(),
  });
  const opened = service.createRun({
    requestId: 'web-run-request-1',
    workspace,
    task: {
      title: 'Inspect the OpenCode task run',
      query: 'Inspect the OpenCode task run',
      profileHints: {
        taskType: 'build',
        target: 'src/web',
        expected: 'operator inspection works',
        constraints: null,
      },
    },
    metadata: { source: 'test' },
    clientVersion: '1.18.25',
    sourceSessionId: 'opencode-web-session',
  });
  new LedgerStore(database, { workspace, now: () => createdAt }).appendBatch(opened.runId, {
    events: [{
      eventId: 'proposal-web-1',
      eventType: 'memory.proposed',
      actor: 'kiokuko-opencode',
      occurredAt: createdAt,
      payload: { title: '<script>sentinel</script>', body: 'Untrusted proposal body' },
    }],
  });
  database.close();

  const web = await startWebServer({
    databasePath,
    host: '127.0.0.1',
    port: 0,
    httpOptions: {
      capabilityToken,
      runtimeDirectory: path.join(directory, 'runtime'),
      descriptorPath: path.join(directory, 'runtime', 'server.json'),
    },
  });
  try {
    const cookie = await sessionCookie(web.url);
    const headers = { cookie };
    const removedPath = ['api', 'v1', 'agent', 'runs'].join('/');
    const removed = await fetch(`${web.url}/${removedPath}`, { headers });
    assert.equal(removed.status, 404);

    const runs = await fetch(`${web.url}/api/operator/runs?workspace=${encodeURIComponent(workspace)}&limit=1`, { headers });
    assert.equal(runs.status, 200);
    const page = await runs.json() as { items: Array<{ runId: string; client: { kind: string } }> };
    assert.deepEqual(page.items.map((run) => [run.runId, run.client.kind]), [[opened.runId, 'opencode']]);

    const detail = await fetch(`${web.url}/api/operator/runs/${encodeURIComponent(opened.runId)}`, { headers });
    assert.equal(detail.status, 200);
    const value = await detail.json() as {
      run: { runId: string };
      timeline: { items: Array<{ eventType: string }> };
      untrusted: boolean;
    };
    assert.equal(value.run.runId, opened.runId);
    assert.equal(value.timeline.items.some((event) => event.eventType === 'memory.proposed'), true);
    assert.equal(value.untrusted, true);
  } finally {
    await web.close();
  }
});
