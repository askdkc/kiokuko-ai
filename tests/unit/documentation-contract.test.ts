import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

const repositoryRoot = path.resolve(import.meta.dirname, '../..');

async function readRepositoryFile(relativePath: string): Promise<string> {
  return readFile(path.join(repositoryRoot, relativePath), 'utf8');
}

test('documented OpenCode MCP command matches the published CLI bin', async () => {
  const [packageText, ...documentation] = await Promise.all([
    readRepositoryFile('package.json'),
    readRepositoryFile('docs/opencode-integration.md'),
    readRepositoryFile('docs/getting-started.md'),
    readRepositoryFile('docs/getting-started.ja.md'),
  ]);
  const packageJson = JSON.parse(packageText) as { bin?: Record<string, string> };
  assert.equal(packageJson.bin?.['kiokuko-ai'], 'dist/bin/kiokuko.js');
  for (const document of documentation) {
    assert.match(document, /\["kiokuko-ai",\s*"mcp"\]/u);
    assert.doesNotMatch(document, /\["kiokuko",\s*"mcp"\]/u);
  }
});

test('all maintained README translations retain the MCP non-guarantee', async () => {
  const documents = await Promise.all([
    readRepositoryFile('README.md'),
    readRepositoryFile('README.ja.md'),
    readRepositoryFile('README.zh-CN.md'),
    readRepositoryFile('README.ko.md'),
  ]);
  for (const document of documents) {
    assert.doesNotMatch(document, /\bOpencode\b/u);
    assert.match(document, /MCP tool/u);
  }
  assert.match(documents[0]!, /no guarantee[\s\S]*MCP tool/u);
  assert.match(documents[1]!, /MCP tool[\s\S]*保証はありません/u);
  assert.match(documents[2]!, /不保证[\s\S]*MCP tool/u);
  assert.match(documents[3]!, /MCP tool[\s\S]*보장은 없습니다/u);
});
