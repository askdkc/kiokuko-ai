import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { openConnection } from '../../src/db/connection.js';
import { createSampleDatabase, SAMPLE_DATABASE_SCHEMA_VERSION } from '../fixtures/sample-database.js';
import { CURRENT_SCHEMA_VERSION, CURRENT_MIGRATION_VERSIONS } from '../fixtures/current-migrations.js';

test('generated and committed sample databases match the complete current migration history', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'sample-current-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const generated = path.join(root, 'generated.sqlite');
  await createSampleDatabase(generated);
  assert.equal(SAMPLE_DATABASE_SCHEMA_VERSION, CURRENT_SCHEMA_VERSION);
  const committed = path.resolve('tests/sampledb/kiokuko-ai.sqlite');
  for (const file of [generated, committed]) {
    const database = openConnection(file, { readOnly: true });
    try {
      assert.equal(database.prepare('PRAGMA user_version').get<{ user_version: number }>()!.user_version, CURRENT_SCHEMA_VERSION);
      assert.deepEqual(database.prepare('SELECT version FROM schema_migrations ORDER BY version').all<{ version: number }>().map(x => x.version), CURRENT_MIGRATION_VERSIONS);
      assert.deepEqual(database.prepare('PRAGMA foreign_key_check').all(), []);
    } finally {
      database.close();
    }
  }
  assert.deepEqual(await readFile(generated), await readFile(committed), 'Committed fixture must match deterministic regeneration');
});
