import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { initializeDatabase } from '../../src/commands/init.js';
import { getGlobalDatabasePath } from '../../src/config/paths.js';
import { openConnection } from '../../src/db/connection.js';
import { resolveProjectWorkspace } from '../../src/memory/workspaces.js';
import { recordEntry } from '../../src/memory/entries.js';
import { buildStructuredScope } from '../../src/memory/structured-memory.js';
import { linkEntries, supersedeEntry } from '../../src/memory/lifecycle.js';
import { recallEntries } from '../../src/memory/retrieval.js';
import { retrieveFederatedMemory } from '../../src/memory/federated-retrieval.js';
import { ContextBroker } from '../../src/context/broker.js';
import { queryScopedContext } from '../../src/context/scoped-broker.js';
import { createKiokukoMcpServer } from '../../src/mcp/server.js';
import { startWebServer } from '../../src/web/server.js';

async function fixture(t: TestContext) {
  const root = await mkdtemp(path.join(tmpdir(), 'relation-output-'));
  const data = path.join(root, 'data');
  const databasePath = getGlobalDatabasePath({ env: { KIOKUKO_DATA_DIR: data } });
  execFileSync('git', ['init', '-q', root]);
  await initializeDatabase({ databasePath });
  const database = openConnection(databasePath);
  const project = (await resolveProjectWorkspace(database, root))!;
  const scope = buildStructuredScope({ visibility: 'project', retrievalScope: 'project-only', repositoryId: project.repositoryId });
  const a = recordEntry(database, { workspace: project.workspace, kind: 'fact', title: 'quartzmarker body', body: '😀'.repeat(12_000), scope });
  const b = recordEntry(database, { workspace: project.workspace, kind: 'fact', title: 'quartzmarker correction', body: 'A current counterexample for quartzmarker.', scope });
  for (const relation of ['supports', 'contradicts'] as const) linkEntries(database, { workspace: project.workspace, fromEntryId: a.id, toEntryId: b.id, relation });
  linkEntries(database, { workspace: project.workspace, fromEntryId: b.id, toEntryId: a.id, relation: 'derived_from' });
  t.after(async () => { database.close(); await rm(root, { recursive: true, force: true }); });
  return { root, data, databasePath, database, project, scope, a, b };
}

test('default recall passes 8k, counts Unicode, respects explicit body budget and keeps typed links separately', async t => {
  const f = await fixture(t);
  const result = recallEntries(f.database, { workspace: f.project.workspace, query: 'quartzmarker', limit: 20 });
  assert.ok(result.characterCount > 8_000); assert.ok(result.characterCount <= 16_000);
  assert.ok(result.relationDelivery); assert.equal(result.relationDelivery.status, 'complete');
  assert.equal(result.relationDelivery.edges.length, 3);
  assert.ok(result.relationDelivery.edges.some(edge => edge.type === 'contradicts'));
  assert.ok(result.relationDelivery.edges.some(edge => edge.type === 'derived_from' && edge.from.entryId === f.b.id));
  const small = recallEntries(f.database, { workspace: f.project.workspace, query: 'quartzmarker', maxChars: 500, limit: 20 });
  assert.ok(small.characterCount <= 500); assert.equal(small.truncated, true);
  assert.ok(small.relationDelivery?.selectionOmissions.includes('body_budget'));
  assert.ok(result.items.every(item => item.workspace === f.project.workspace && item.id));
});

test('superseded defaults and explicit historical inclusion define the final relation endpoints', async t => {
  const f = await fixture(t);
  const replacement = recordEntry(f.database, { workspace: f.project.workspace, kind: 'fact', title: 'quartzmarker replacement', body: 'Corrected statement.', scope: f.scope });
  supersedeEntry(f.database, { workspace: f.project.workspace, oldEntryId: f.a.id, replacementEntryId: replacement.id, expectedRevision: 1 });
  const current = recallEntries(f.database, { workspace: f.project.workspace, query: 'quartzmarker', limit: 20 });
  assert.ok(!current.items.some(item => item.id === f.a.id));
  assert.ok(current.relationDelivery); assert.equal(current.relationDelivery.edges.length, 0);
  const historical = recallEntries(f.database, { workspace: f.project.workspace, query: 'quartzmarker', limit: 20, includeSuperseded: true });
  assert.ok(historical.items.some(item => item.id === f.a.id)); assert.equal(historical.relationDelivery?.edges.length, 3);
});

test('scoped and generic brokers and federated recall carry relations for their final provided item sets', async t => {
  const f = await fixture(t);
  const profile = { taskType: 'analysis' as const, target: 'quartzmarker', expected: 'Recall source and counterexample', constraints: 'Read only' };
  const generic = await new ContextBroker(f.database).query({ workspace: f.project.workspace, task: 'quartzmarker', taskProfile: profile });
  const scoped = await queryScopedContext(f.database, { project: f.project, task: 'quartzmarker', taskProfile: profile });
  const federated = await retrieveFederatedMemory(f.database, { project: f.project, query: 'quartzmarker', scope: 'auto', limit: 20 });
  for (const output of [generic.context, scoped, federated.combined]) {
    assert.ok(output); assert.ok(output.relationDelivery); assert.equal(output.relationDelivery.status, 'complete');
    assert.equal(output.relationDelivery.edges.length, 3);
    const ids = new Set(output.items.map(item => 'entryId' in item ? item.entryId : item.id));
    assert.ok(output.relationDelivery.edges.every(edge => ids.has(edge.from.entryId) && ids.has(edge.to.entryId)));
  }
  const capped = recallEntries(f.database, { workspace: f.project.workspace, query: 'quartzmarker', limit: 1 });
  assert.ok(capped.relationDelivery?.selectionOmissions.includes('item_limit'));
});

test('CLI JSON preserves final model-visible identities and relation envelope', async t => {
  const f = await fixture(t);
  const result = spawnSync(process.execPath, ['--import', 'tsx', path.resolve('src/bin/kiokuko.ts'), 'recall', 'quartzmarker', '--workspace', f.project.workspace, '--json'], {
    env: { ...process.env, KIOKUKO_DATA_DIR: f.data }, encoding: 'utf8', cwd: path.resolve('.'),
  });
  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout).data;
  assert.ok(output.characterCount > 8_000); assert.equal(output.relationDelivery.status, 'complete');
  assert.equal(output.relationDelivery.edges.length, 3);
  assert.ok(output.items.some((item: { id: string }) => item.id === f.a.id));
});

test('MCP task preparation keeps the same relation envelope in structured and model text outputs', async t => {
  const f = await fixture(t);
  const server = createKiokukoMcpServer({ databasePath: f.databasePath, cwd: () => f.root });
  const client = new Client({ name: 'opencode', version: '2.0.18' });
  const [c, s] = InMemoryTransport.createLinkedPair();
  await server.connect(s); await client.connect(c);
  t.after(async () => { await client.close(); await server.close(); });
  const response = await client.callTool({ name: 'task_prepare', arguments: {
    soulRead: true, requestId: 'relation-envelope', cwd: f.root, task: 'Analyze quartzmarker source and counterexample',
    profileHints: { taskType: 'analysis', target: 'quartzmarker', expected: 'Recall source and counterexample', constraints: 'Read only' },
    capabilities: [{ kind: 'skill', name: 'kiokuko-soul' }, { kind: 'skill', name: 'memory-reasoning' }],
  } });
  assert.notEqual(response.isError, true, JSON.stringify(response));
  const text = (response.content as Array<{ type: string; text?: string }>).filter(item => item.type === 'text').map(item => item.text ?? '').join('');
  assert.deepEqual(JSON.parse(text), JSON.parse(JSON.stringify(response.structuredContent)));
  const decoded = JSON.parse(text) as { context?: { relationDelivery?: { status: string; edges: unknown[] }; items: Array<{ entryId: string }> } };
  assert.ok(decoded.context?.relationDelivery, text.slice(0, 1000));
  assert.equal(decoded.context.relationDelivery.status, 'complete');
  assert.equal(decoded.context.relationDelivery.edges.length, 3);
  assert.ok(decoded.context.items.some((item: { entryId: string }) => item.entryId === f.a.id));
  if ((await client.listTools()).tools.some(tool => tool.name === 'memory_recall')) {
    const response = await client.callTool({ name: 'memory_context', arguments: { cwd: f.root, query: 'quartzmarker' } });
    const legacy = response.structuredContent as { available: boolean; entries: Array<{entryId:string;workspace:string}>; relationDelivery: {status:string;edges:unknown[]} };
    assert.equal(legacy.available, true); assert.equal(legacy.entries.length, 2);
    assert.equal(legacy.relationDelivery.status, 'complete'); assert.equal(legacy.relationDelivery.edges.length, 3);
    assert.ok(legacy.entries.every(item => item.workspace === f.project.workspace));
    const failed = await client.callTool({ name: 'memory_context', arguments: { cwd: f.root, query: 'quartzmarker', maxContextChars: 1 } });
    const failure = failed.structuredContent as { available: boolean; warnings: string[] };
    assert.equal(failure.available, false); assert.ok(failure.warnings.length > 0);
  }
});

test('the authenticated Web recall route uses the same defaults and respects explicit limits', async t => {
  const f = await fixture(t);
  const web = await startWebServer({ databasePath: f.databasePath, host: '127.0.0.1', port: 0,
    httpOptions: { runtimeDirectory: path.join(f.root, 'runtime') } });
  try {
    const session = await fetch(web.url), cookie = session.headers.get('set-cookie')!.split(';', 1)[0]!;
    const base = web.url + '/api/memory/recall?workspace=' + encodeURIComponent(f.project.workspace) + '&q=quartzmarker';
    const get = (extra = '') => fetch(base + extra, { headers: { cookie } });
    const response = await get(); assert.equal(response.status, 200);
    const output = await response.json() as { combined: { characterCount: number; relationDelivery: { edges: unknown[] } } };
    assert.ok(output.combined.characterCount > 8_000 && output.combined.characterCount <= 16_000);
    assert.equal(output.combined.relationDelivery.edges.length, 3);
    const bounded = await (await get('&maxChars=500')).json() as { combined: { characterCount: number } };
    assert.ok(bounded.combined.characterCount <= 500);
    assert.equal((await get('&maxChars=0')).status, 400);
  } finally { await web.close(); }
});

test('MCP answers reuse the run-bound explicit budget when the caller omits it', async t => {
  const f = await fixture(t), server = createKiokukoMcpServer({ databasePath: f.databasePath, cwd: () => f.root });
  const client = new Client({ name: 'opencode', version: '2.0.18' });
  const [c, s] = InMemoryTransport.createLinkedPair(); await server.connect(s); await client.connect(c);
  t.after(async () => { await client.close(); await server.close(); });
  const capabilities = [{ kind: 'skill', name: 'kiokuko-soul' }, { kind: 'skill', name: 'memory-reasoning' }];
  const prepared = await client.callTool({ name: 'task_prepare', arguments: {
    soulRead: true, requestId: 'bound-budget-answer', cwd: f.root, task: 'Analyze quartzmarker', maxContextChars: 5000,
    profileHints: { taskType: 'analysis', target: 'quartzmarker', constraints: 'Read only' }, capabilities,
  } });
  assert.notEqual(prepared.isError, true);
  const pending = prepared.structuredContent as { run: { runId: string }; intake: { sessionId: string; question: { id: string } } };
  assert.equal(pending.intake.question.id, 'expected');
  const answered = await client.callTool({ name: 'task_answer', arguments: {
    cwd: f.root, runId: pending.run.runId, sessionId: pending.intake.sessionId, questionId: 'expected',
    value: 'Recall the source and counterexample', capabilities,
  } });
  assert.notEqual(answered.isError, true, JSON.stringify(answered));
  const output = answered.structuredContent as { context: { relationDelivery: unknown; items: Array<{title:string;summary:string|null;bodyPreview:string}> } };
  assert.ok(output.context.relationDelivery);
  assert.ok(output.context.items.reduce((sum, item) => sum + Array.from(item.title + (item.summary ?? '') + item.bodyPreview).length, 0) <= 5000);
});
