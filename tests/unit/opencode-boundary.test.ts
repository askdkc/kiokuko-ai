import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

const root = path.resolve(import.meta.dirname, '../..');
const checker = path.join(root, 'scripts/verify-opencode-boundary.mjs');
const excludedName = ['co', 'dex'].join('');

test('public boundary permits only the source snapshot exclusion literal', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'kiokuko-boundary-'));
  try {
    for (const name of ['src/source-context', 'tests', 'scripts', 'docs', 'migrations']) {
      await mkdir(path.join(directory, name), { recursive: true });
    }
    await writeFile(path.join(directory, 'package.json'), '{}');
    await writeFile(path.join(directory, 'src/cli.ts'), '');
    for (const name of await readdir(path.join(root, 'migrations'))) {
      if (name.endsWith('.sql')) await writeFile(path.join(directory, 'migrations', name), '');
    }
    const source = path.join(directory, 'src/source-context/snapshot.ts');
    const declaration = `const EXCLUDED = new Set(['.git', '.${excludedName}']);\n`;
    await writeFile(source, declaration);
    const run = () => execFileSync(process.execPath, [checker], { cwd: directory, encoding: 'utf8', stdio: 'pipe' });
    assert.match(run(), /public boundary verified/u);

    for (const content of [
      declaration + `export const client = '${excludedName}';\n`,
      declaration.trimEnd() + ` // supports ${excludedName}\n`,
      `export const directory = '.${excludedName}';\n`,
    ]) {
      await writeFile(source, content);
      assert.throws(run, error => error !== null && typeof error === 'object' && 'status' in error && error.status === 1);
    }
    await writeFile(source, declaration);
    await writeFile(path.join(directory, 'src/other.ts'), declaration);
    assert.throws(run, error => error !== null && typeof error === 'object' && 'status' in error && error.status === 1);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
