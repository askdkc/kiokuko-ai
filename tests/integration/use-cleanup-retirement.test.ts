import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { useRepository } from '../../src/commands/use.js';
import { renderAgentFile } from '../../src/agent-file/render.js';
import { atomicWriteTextIfUnchanged, readRegularFile } from '../../src/agent-file/atomic-write.js';
import { openConnection } from '../../src/db/connection.js';

type Route = 'agent-write' | 'binding-retry';
type Completion = 'intended' | 'foreign' | 'missing';
async function exercise(route: Route, completion: Completion) {
  const root = await fs.mkdtemp(path.join(tmpdir(), 'use-cleanup-retirement-'));
  execFileSync('git', ['init', '-q', root]);
  const agentPath = path.join(root, 'AGENTS.md'), databasePath = path.join(root, 'memory.sqlite3');
  await fs.writeFile(agentPath, 'human header\n');
  let release!: () => void, reached!: () => void;
  const released = new Promise<void>(resolve => { release = resolve; });
  const quarantined = new Promise<void>(resolve => { reached = resolve; });
  let peer: ReturnType<typeof atomicWriteTextIfUnchanged> | undefined;
  let injected = false, listed = false, agentAbsentObserved = false;
  const original = fs.readdir;
  fs.readdir = (async (...args: unknown[]) => {
    const names: unknown = await Reflect.apply(original, fs, args);
    if (injected && (route === 'agent-write' || agentAbsentObserved) && !listed && args[0] === root
      && Array.isArray(names) && names.some(name => typeof name === 'string' && /^\.AGENTS\.md\..*\.previous$/u.test(name))) {
      listed = true;
      // Return the real listing only after its owner has finished installing and cleaning up.
      release(); await peer;
      if (completion === 'foreign') await fs.writeFile(agentPath, 'foreign content\n');
      if (completion === 'missing') await fs.unlink(agentPath);
    }
    return names;
  }) as typeof fs.readdir;
  syncBuiltinESMExports();
  try {
    const operation = useRepository({ root, databasePath }, {
      readAgentFileForConvergence: async (file, options) => {
        const snapshot = await readRegularFile(file, options);
        if (injected && file === agentPath && snapshot === undefined) agentAbsentObserved = true;
        return snapshot;
      },
      atomicWriteTextIfUnchanged: async (file, content, expectation, mode) => {
        const target = route === 'agent-write' ? agentPath : path.join(root, '.kiokuko-ai.json');
        if (!injected && file === target) {
          injected = true;
          if (route === 'agent-write') {
            peer = atomicWriteTextIfUnchanged(file, content, expectation, mode, {
              afterRename: async () => { reached(); await released; },
            });
          } else {
            const binding = { ...JSON.parse(content), repositoryId: 'repo_peer_retired', workspace: 'project:peer-retired' };
            await atomicWriteTextIfUnchanged(file, JSON.stringify(binding, null, 2) + '\n', expectation, mode);
            const planned = (await readRegularFile(agentPath))!;
            peer = atomicWriteTextIfUnchanged(agentPath, renderAgentFile(planned.content, {
              ...binding, cliCommand: 'kiokuko-ai',
            }).content, { expected: planned, containmentRoot: root }, planned.mode, {
              afterRename: async () => { reached(); await released; },
            });
          }
          void peer.catch(() => undefined);
          await quarantined;
        }
        return atomicWriteTextIfUnchanged(file, content, expectation, mode);
      },
    });
    if (completion === 'intended') {
      const result = await operation;
      if (route === 'binding-retry') assert.equal(result.workspace, 'project:peer-retired');
      const text = await fs.readFile(agentPath, 'utf8');
      assert.ok(text.startsWith('human header\n'));
      assert.equal((text.match(/BEGIN KIOKUKO-AI MANAGED BLOCK/gu) ?? []).length, 1);
      const database = openConnection(databasePath);
      try {
        assert.equal(database.prepare('SELECT COUNT(*) AS n FROM repositories').get<{n:number}>()!.n, 1);
        assert.equal(database.prepare('SELECT COUNT(*) AS n FROM repository_locations').get<{n:number}>()!.n, 1);
      } finally { database.close(); }
    } else {
      await assert.rejects(operation, { code: 'CONFLICT' });
      if (completion === 'foreign') assert.equal(await fs.readFile(agentPath, 'utf8'), 'foreign content\n');
      else await assert.rejects(fs.access(agentPath), { code: 'ENOENT' });
    }
    assert.equal(injected, true); assert.equal(listed, true);
    assert.deepEqual((await original(root)).filter(name => name.startsWith('.AGENTS.md.')), []);
  } finally {
    release(); await peer?.catch(() => undefined);
    fs.readdir = original; syncBuiltinESMExports();
    await fs.rm(root, { recursive: true, force: true });
  }
}
for (const route of ['agent-write', 'binding-retry'] as const) {
  test(`use converges when ${route} quarantine retires between listing and read`, { timeout: 10_000 }, () => exercise(route, 'intended'));
}
for (const completion of ['foreign', 'missing'] as const) {
  test(`use rejects ${completion} target after a retired quarantine without overwriting or recreating it`, { timeout: 10_000 }, () => exercise('binding-retry', completion));
}
