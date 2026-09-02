import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { initializeDatabase } from '../../src/commands/init.js';
import { startAgentHttpServer } from '../../src/server/agent-application.js';
import { startWebServer } from '../../src/web/server.js';

const capabilityToken = 'f'.repeat(64);
const workspace = 'project:task7';
const createdAt = '2026-08-20T00:00:00.000Z';

function openBody() {
  return {
    apiVersion: '1', workspace,
    client: { kind: 'task7-test', version: '1' },
    task: { title: 'Task 7 operator integration', query: 'verify the operator route', profileHints: { taskType: 'build', target: 'src/web', expected: 'tests pass', constraints: null } },
    captureProfile: 'standard',
    coverage: { run: 'complete', tool: 'complete', command: 'complete', file: 'complete', approval: 'complete' },
  };
}

function proposalBody() {
  return {
    kind: 'reference', title: '<script>sentinel</script>', body: 'Untrusted proposal body', summary: 'operator detail', scope: {}, tags: ['task7'],
  };
}

async function agentRequest(baseUrl: string, pathname: string, options: { method?: string; body?: unknown; key?: string; token?: string } = {}) {
  const headers: Record<string, string> = { authorization: `Bearer ${options.token ?? capabilityToken}` };
  if (options.body !== undefined) headers['content-type'] = 'application/json';
  if (options.key !== undefined) headers['idempotency-key'] = options.key;
  const response = await fetch(`${baseUrl}${pathname}`, { method: options.method ?? 'GET', headers, ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }) });
  return { response, value: await response.json() as any };
}

async function fixture() {
  const directory = await mkdtemp(path.join(tmpdir(), 'kiokuko-task7-'));
  const databasePath = path.join(directory, 'data.sqlite3');
  await initializeDatabase({ databasePath });
  const agent = await startAgentHttpServer({ databasePath, runtimeDirectory: path.join(directory, 'agent-runtime'), descriptorPath: path.join(directory, 'agent-runtime', 'server.json'), capabilityToken });
  return { directory, databasePath, agent };
}

async function sessionCookie(baseUrl: string): Promise<string> {
  const response = await fetch(baseUrl);
  const cookie = response.headers.get('set-cookie')?.split(';', 1)[0];
  if (!cookie?.startsWith('kiokuko_ui_session=')) throw new Error('UI session cookie was not issued');
  return cookie;
}

test('promotion route is authenticated, queued, explicit, idempotent, and shared by agent/web', async () => {
  const data = await fixture();
  let web: Awaited<ReturnType<typeof startWebServer>> | undefined;
  try {
    const unauthenticated = await fetch(`${data.agent.url}/api/v1/agent/runs/not-a-run/promotions`, { method: 'POST', headers: { 'idempotency-key': 'no-auth', 'content-type': 'application/json' }, body: '{bad' });
    assert.equal(unauthenticated.status, 401);
    assert.doesNotMatch(await unauthenticated.text(), /bad|not-a-run/);

    const opened = await agentRequest(data.agent.url, '/api/v1/agent/runs', { method: 'POST', key: 'open-7', body: openBody() });
    assert.equal(opened.response.status, 200);
    const runId = opened.value.data.runId as string;
    const appended = await agentRequest(data.agent.url, `/api/v1/agent/runs/${encodeURIComponent(runId)}/events`, {
      method: 'POST', key: 'event-7', body: { apiVersion: '1', events: [{ eventId: 'proposal-7', eventType: 'memory.proposed', actor: 'test', occurredAt: createdAt, payload: proposalBody() }] },
    });
    assert.equal(appended.response.status, 200);

    const body = { apiVersion: '1', proposalEventId: 'proposal-7', actor: 'operator', createdAt, confirmed: true };
    const missingVersion = await agentRequest(data.agent.url, `/api/v1/agent/runs/${encodeURIComponent(runId)}/promotions`, {
      method: 'POST', key: 'promote-missing-version', body: { proposalEventId: 'proposal-7', actor: 'operator', createdAt, confirmed: true },
    });
    assert.equal(missingVersion.response.status, 400);
    const wrongVersion = await agentRequest(data.agent.url, `/api/v1/agent/runs/${encodeURIComponent(runId)}/promotions`, {
      method: 'POST', key: 'promote-wrong-version', body: { ...body, apiVersion: '2' },
    });
    assert.equal(wrongVersion.response.status, 400);
    const promoted = await agentRequest(data.agent.url, `/api/v1/agent/runs/${encodeURIComponent(runId)}/promotions`, { method: 'POST', key: 'promote-7', body });
    assert.equal(promoted.response.status, 200);
    assert.equal(promoted.value.operation, 'agent.promotions');
    assert.equal(promoted.value.data.entry.status, 'candidate');
    assert.equal(promoted.value.data.entry.trustLevel, 'untrusted');
    assert.equal(promoted.value.data.untrusted, true);
    assert.equal(promoted.value.data.entry.provenance.type, 'ledger_promotion');
    const replay = await agentRequest(data.agent.url, `/api/v1/agent/runs/${encodeURIComponent(runId)}/promotions`, { method: 'POST', key: 'promote-7', body });
    assert.deepEqual(replay.value, promoted.value);
    const conflict = await agentRequest(data.agent.url, `/api/v1/agent/runs/${encodeURIComponent(runId)}/promotions`, { method: 'POST', key: 'promote-7', body: { ...body, actor: 'different' } });
    assert.equal(conflict.response.status, 409);

    await data.agent.close();
    web = await startWebServer({ databasePath: data.databasePath, host: '127.0.0.1', port: 0, httpOptions: { capabilityToken: capabilityToken, runtimeDirectory: path.join(data.directory, 'web-runtime'), descriptorPath: path.join(data.directory, 'web-runtime', 'server.json') } });
    const cookie = await sessionCookie(web.url);
    const shared = await fetch(`${web.url}/api/v1/agent/runs/${encodeURIComponent(runId)}/promotions`, { method: 'POST', headers: { authorization: `Bearer ${capabilityToken}`, 'idempotency-key': 'promote-web-7', 'content-type': 'application/json', cookie }, body: JSON.stringify(body) });
    assert.equal(shared.status, 200);
    assert.equal((await shared.json()).operation, 'agent.promotions');
  } finally {
    await web?.close().catch(() => undefined);
    if (data.agent.server.listening) await data.agent.close();
  }
});

test('operator UI endpoints use the UI session, expose bounded run detail, and keep stored text untrusted', async () => {
  const data = await fixture();
  let web: Awaited<ReturnType<typeof startWebServer>> | undefined;
  try {
    const opened = await agentRequest(data.agent.url, '/api/v1/agent/runs', { method: 'POST', key: 'open-ui-7', body: openBody() });
    const runId = opened.value.data.runId as string;
    await agentRequest(data.agent.url, `/api/v1/agent/runs/${encodeURIComponent(runId)}/events`, { method: 'POST', key: 'event-ui-7', body: { apiVersion: '1', events: [{ eventId: 'proposal-ui-7', eventType: 'memory.proposed', actor: 'test', occurredAt: createdAt, payload: proposalBody() }] } });
    await data.agent.close();
    web = await startWebServer({ databasePath: data.databasePath, host: '127.0.0.1', port: 0, httpOptions: { capabilityToken, runtimeDirectory: path.join(data.directory, 'ui-runtime'), descriptorPath: path.join(data.directory, 'ui-runtime', 'server.json') } });
    const root = await fetch(web.url);
    const setCookie = root.headers.get('set-cookie') ?? '';
    assert.match(setCookie, /HttpOnly/);
    assert.match(setCookie, /SameSite=Strict/);
    const html = await root.text();
    assert.doesNotMatch(html, new RegExp(capabilityToken));
    assert.doesNotMatch(html, /innerHTML/);
    assert.match(html, /textContent/);
    assert.equal((await fetch(`${web.url}/api/operator/runs?workspace=${encodeURIComponent(workspace)}`)).status, 401);
    const cookie = setCookie.split(';', 1)[0];
    if (!cookie) throw new Error('UI session cookie missing');
    const csrf = await fetch(`${web.url}/api/operator/runs?workspace=${encodeURIComponent(workspace)}`, { headers: { cookie, origin: 'http://evil.example' } });
    assert.equal(csrf.status, 401);
    const headers = { cookie };
    const runs = await fetch(`${web.url}/api/operator/runs?workspace=${encodeURIComponent(workspace)}&limit=1`, { headers });
    assert.equal(runs.status, 200);
    const runPage = await runs.json() as any;
    assert.equal(runPage.items.length, 1);
    const detail = await fetch(`${web.url}/api/operator/runs/${encodeURIComponent(runId)}`, { headers });
    assert.equal(detail.status, 200);
    const value = await detail.json() as any;
    assert.deepEqual(value.profile.initial, value.profile.projected);
    assert.equal(value.timeline.items.find((event: any) => event.eventType === 'memory.proposed')?.eventType, 'memory.proposed');
    assert.equal(value.untrusted, true);
    assert.ok(Array.isArray(value.deliveries.items));
    assert.ok(value.feedback.context && value.feedback.run && value.feedback.intake);
    assert.match(JSON.stringify(value), /sentinel/);
  } finally {
    await web?.close().catch(() => undefined);
    if (data.agent.server.listening) await data.agent.close();
  }
});
