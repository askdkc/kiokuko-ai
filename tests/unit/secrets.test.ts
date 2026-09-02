import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { openConnection } from '../../src/db/connection.js';
import { migrateDatabase } from '../../src/db/migrate.js';
import { recordEntry } from '../../src/memory/entries.js';
import { containsSecret, findSecret } from '../../src/memory/secrets.js';

async function database() {
  const directory = await mkdtemp(path.join(tmpdir(), 'kiokuko-secret-'));
  const db = openConnection(path.join(directory, 'db.sqlite3'));
  migrateDatabase(db);
  return db;
}

test('rejects common secret formats without exposing the value', async () => {
  const db = await database();
  try {
    assert.equal(findSecret('Authorization: Bearer abcdefghijklmnop')?.kind, 'authorization_header');
    assert.equal(containsSecret('api_key = "sk-abcdefghijklmnop"'), true);
    assert.equal(findSecret('--api-key abcdefghijkl')?.kind, 'credential_assignment');
    assert.equal(containsSecret('--api-key value'), false);
    assert.equal(containsSecret('The token field is a normal concept.'), false);
    assert.throws(() => recordEntry(db, { workspace: 'project:secret', kind: 'fact', title: 'credential', body: 'password = super-secret-value-12345' }), (error: unknown) => {
      assert.equal((error as { code: string }).code, 'SECURITY_REJECTION');
      assert.equal((error as Error).message.includes('super-secret'), false);
      return true;
    });
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM entries').get<{ count: number }>()?.count, 0);
    assert.throws(() => recordEntry(db, {
      workspace: 'project:secret',
      kind: 'fact',
      title: 'metadata',
      body: 'safe body',
      scope: { note: 'api_key = hidden-secret-value-12345' },
    }), (error: unknown) => {
      assert.equal((error as { code: string }).code, 'SECURITY_REJECTION');
      return true;
    });
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM entries').get<{ count: number }>()?.count, 0);
  } finally {
    db.close();
  }
});
