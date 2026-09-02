import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { openConnection } from '../../src/db/connection.js';
import { migrateDatabase } from '../../src/db/migrate.js';
import { initializeDatabase } from '../../src/commands/init.js';

async function temp(prefix: string): Promise<string> {
  return mkdtemp(path.join(tmpdir(), `kiokuko-${prefix}-`));
}

function runWorker(script: string, env: NodeJS.ProcessEnv): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx', script], {
      cwd: process.cwd(),
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stderr = '';
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${script} exited ${code}: ${stderr}`));
    });
  });
}

test('8 processes × 10 records complete without loss or lock errors', async () => {
  const directory = await temp('concurrency-records');
  const databasePath = path.join(directory, 'data', 'kiokuko-ai.sqlite');
  const workerPath = path.resolve('tests/fixtures/concurrent-writer.ts');
  await Promise.all(Array.from({ length: 8 }, (_, worker) => runWorker(workerPath, {
    KIOKUKO_TEST_DATABASE: databasePath,
    KIOKUKO_TEST_WORKER: String(worker),
  })));
  const database = openConnection(databasePath);
  try {
    migrateDatabase(database);
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM entries WHERE workspace = 'project:concurrency'").get<{ count: number }>()?.count, 80);
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM audit_events WHERE workspace = 'project:concurrency' AND operation = 'record'").get<{ count: number }>()?.count, 80);
    assert.equal(database.prepare('PRAGMA integrity_check').get<{ integrity_check: string }>()?.integrity_check, 'ok');
  } finally {
    database.close();
  }
});

test('concurrent use creates one binding and one managed block without losing user content', async () => {
  const root = await temp('concurrency-use');
  execFileSync('git', ['init', '-q', root]);
  await import('node:fs/promises').then(({ writeFile }) => writeFile(path.join(root, 'AGENTS.md'), 'human header\n'));
  const data = await temp('concurrency-use-data');
  const databasePath = path.join(data, 'kiokuko-ai.sqlite');
  await initializeDatabase({ databasePath });
  const workerPath = path.resolve('tests/fixtures/concurrent-use.ts');
  await Promise.all(Array.from({ length: 2 }, () => runWorker(workerPath, {
    KIOKUKO_TEST_ROOT: root,
    KIOKUKO_TEST_DATABASE: databasePath,
  })));
  const agent = await readFile(path.join(root, 'AGENTS.md'), 'utf8');
  assert.equal((agent.match(/BEGIN KIOKUKO MANAGED BLOCK/g) ?? []).length, 1);
  assert.equal((agent.match(/END KIOKUKO MANAGED BLOCK/g) ?? []).length, 1);
  assert.match(agent, /^human header\n/);
  const database = openConnection(databasePath);
  try {
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM repositories').get<{ count: number }>()?.count, 1);
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM repository_locations').get<{ count: number }>()?.count, 1);
  } finally {
    database.close();
  }
});
