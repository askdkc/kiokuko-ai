import assert from 'node:assert/strict';
import test from 'node:test';
import { rm, writeFile, rename, readFile } from 'node:fs/promises';
import path from 'node:path';
import { SourceContextService } from '../../src/source-context/service.js';
import { sourceFixture } from '../fixtures/source-context.js';
import { createKiokukoMcpServer } from '../../src/mcp/server.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

test('source_context is a read-only, database-independent bounded MCP operation', async () => {
  let databaseOpened = false;
  const server = createKiokukoMcpServer({ initializeDatabase: () => { databaseOpened = true; throw new Error('must not initialize'); } });
  const client = new Client({ name: 'opencode', version: '1.18.26' });
  const [a,b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), client.connect(b)]);
  try {
    const tool = (await client.listTools()).tools.find(t => t.name === 'source_context');
    assert.equal(tool?.annotations?.readOnlyHint, true);
    const response = await client.callTool({ name: 'source_context', arguments: { cwd: 'relative', task: 'investigate' } });
    assert.equal(response.isError, true); assert.equal(databaseOpened, false);
  } finally { await client.close(); await server.close(); }
});

test('pinned ripwire parses TS/MTS/TSX/JS and refreshes deletion and rename without editing the project', {
  skip: !process.env.KIOKUKO_TEST_RIPWIRE,
}, async t => {
  const binary = process.env.KIOKUKO_TEST_RIPWIRE!;
  assert.ok(path.isAbsolute(binary));
  const f = await sourceFixture(binary); t.after(() => rm(f.base, { recursive: true, force: true }));
  await rm(path.join(f.root, 'code.ts'));
  for (const [ext, name] of [['ts','typedProbe'],['mts','moduleProbe'],['tsx','viewProbe'],['js','scriptProbe']] as const)
    await writeFile(path.join(f.root, `code.${ext}`), `export function ${name}() { return 42; }\nexport function use${name}() { return ${name}(); }\n`);
  await writeFile(path.join(f.root, 'probe.test.ts'), "import { typedProbe } from './code.js';\nexport function testTypedProbe() { return typedProbe() === 42; }\n");
  const service = new SourceContextService();
  for (const [ext, name] of [['ts','typedProbe'],['mts','moduleProbe'],['tsx','viewProbe'],['js','scriptProbe']] as const) {
    const result = await service.inspect({ cwd: f.root, task: name }, { directory: f.directory });
    assert.notEqual(result.status, 'unavailable', JSON.stringify(result));
    assert.ok(result.symbols.some(s => s.path === `code.${ext}` && s.name === name), JSON.stringify(result));
    assert.equal(result.completeness.testsExhaustive, false);
    assert.ok(result.related.some(s => s.name === `use${name}`), JSON.stringify(result.related));
    if (ext === 'ts') assert.ok(result.tests.some(candidate => candidate.path === 'probe.test.ts'), JSON.stringify(result.tests));
  }
  const original = await readFile(path.join(f.root, 'code.mts'), 'utf8');
  await rename(path.join(f.root, 'code.mts'), path.join(f.root, 'renamed.mts'));
  const renamed = await service.inspect({ cwd: f.root, task: 'moduleProbe' }, { directory: f.directory });
  assert.ok(renamed.symbols.some(s => s.path === 'renamed.mts'));
  assert.equal(await readFile(path.join(f.root, 'renamed.mts'), 'utf8'), original);
  await rm(path.join(f.root, 'renamed.mts'));
  const deleted = await service.inspect({ cwd: f.root, task: 'moduleProbe' }, { directory: f.directory });
  assert.ok(!deleted.symbols.some(s => s.path === 'renamed.mts'));
});
