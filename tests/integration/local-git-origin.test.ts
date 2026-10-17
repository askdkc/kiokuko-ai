import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, realpath, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createKiokukoMcpServer } from '../../src/mcp/server.js';
import { openConnection } from '../../src/db/connection.js';
import { migrateDatabase } from '../../src/db/migrate.js';
import { resolveProjectWorkspace, resolveProjectWorkspaceReadOnly } from '../../src/memory/workspaces.js';
import { KiokukoError } from '../../src/errors.js';

const git = (cwd: string, ...args: string[]) => execFileSync('git', args, {
  cwd, stdio: ['ignore', 'pipe', 'pipe'],
});

for (const kind of ['absolute', 'relative', 'file-url'] as const) {
  test(`task_prepare accepts a local Git clone with ${kind} origin without a binding or Skill attestation`, async t => {
    const base = await realpath(await mkdtemp(path.join(tmpdir(), 'kiokuko-local-origin-')));
    t.after(() => rm(base, { recursive: true, force: true }));
    const origin = path.join(base, 'origin with spaces.git');
    git(base, 'init', '--bare', '-q', origin);
    const work = path.join(base, 'working clone');
    git(base, 'clone', '-q', kind === 'file-url' ? pathToFileURL(origin).href : origin, work);
    if (kind === 'relative') git(work, 'remote', 'set-url', 'origin', '../origin with spaces.git');
    const before = await readdir(work);
    const server = createKiokukoMcpServer({ databasePath: path.join(base, 'test.sqlite'), cwd: () => work });
    const client = new Client({ name: 'opencode', version: '1.0.0' });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await server.connect(b); await client.connect(a);
    try {
      const result = await client.callTool({ name: 'task_prepare', arguments: {
        requestId: `local-origin-${kind}`, task: 'Inspect the project', capabilities: [],
      } });
      assert.equal(result.isError, undefined, JSON.stringify(result));
      const prepared = result.structuredContent as {
        continuationPolicy: { codingAllowed: boolean };
        project: { repositoryRoot: string; workspace: string };
      };
      assert.equal(prepared.continuationPolicy.codingAllowed, true);
      assert.equal(prepared.project.repositoryRoot, work);
      assert.ok(prepared.project.workspace);
    } finally { await client.close(); if (server.isConnected()) await server.close(); }
    assert.deepEqual(await readdir(work), before, 'Task preparation must not write a repository binding');
  });
}

test('local origins retain separate canonical-path identities and read-only resolution does not register them', async t => {
  const base = await realpath(await mkdtemp(path.join(tmpdir(), 'kiokuko-local-identities-')));
  t.after(() => rm(base, { recursive: true, force: true }));
  const origin = path.join(base, 'origin.git'); git(base, 'init', '--bare', '-q', origin);
  const database = openConnection(':memory:'); t.after(() => database.close()); migrateDatabase(database);
  const workspaces = [];
  for (const name of ['first', 'second']) {
    const work = path.join(base, name); git(base, 'clone', '-q', origin, work);
    const locationsBefore = database.prepare('SELECT COUNT(*) AS n FROM repository_locations').get<{ n: number }>()!.n;
    const observed = await resolveProjectWorkspaceReadOnly(database, work);
    assert.ok(observed);
    assert.equal(database.prepare('SELECT COUNT(*) AS n FROM repository_locations').get<{ n: number }>()!.n, locationsBefore);
    const registered = await resolveProjectWorkspace(database, work);
    assert.equal(registered?.repositoryId, observed.repositoryId);
    assert.equal(registered?.workspace, observed.workspace);
    assert.equal((await resolveProjectWorkspaceReadOnly(database, work))?.workspace, observed.workspace);
    assert.equal(database.prepare('SELECT remote_fingerprint AS fingerprint FROM repositories WHERE workspace=?').get<{ fingerprint: string | null }>(observed.workspace)?.fingerprint, null);
    workspaces.push(observed.workspace);
  }
  assert.notEqual(workspaces[0], workspaces[1], 'A local origin must not merge independent checkouts implicitly');
});

test('network origins keep shared identity while unsupported network schemes still fail validation', async t => {
  const base = await realpath(await mkdtemp(path.join(tmpdir(), 'kiokuko-network-identities-')));
  t.after(() => rm(base, { recursive: true, force: true }));
  const database = openConnection(':memory:'); t.after(() => database.close()); migrateDatabase(database);
  const workspaces = [];
  for (const [name, origin] of [['https', 'https://example.invalid/org/project.git'], ['ssh', 'git@example.invalid:org/project.git']] as const) {
    const work = path.join(base, name); git(base, 'init', '-q', work); git(work, 'remote', 'add', 'origin', origin);
    workspaces.push((await resolveProjectWorkspace(database, work))?.workspace);
  }
  assert.ok(workspaces[0]); assert.equal(workspaces[0], workspaces[1]);
  const invalid = path.join(base, 'invalid'); git(base, 'init', '-q', invalid);
  git(invalid, 'remote', 'add', 'origin', 'ftp://example.invalid/org/project.git');
  await assert.rejects(resolveProjectWorkspace(database, invalid), (error: unknown) => error instanceof KiokukoError && error.code === 'VALIDATION_ERROR');
});
