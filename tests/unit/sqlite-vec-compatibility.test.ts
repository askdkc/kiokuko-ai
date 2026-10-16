import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { createSqliteVecLoader } from '../../src/embedding/sqlite-vec-loader.js';
import { openConnection, SqliteVecLoadError } from '../../src/db/connection.js';
import { detectSqliteVecCapability } from '../../src/db/capabilities.js';

test('owned sqlite-vec accepts a newer reported version with real vector behavior, and rejects missing distance API', async t => {
  const loader = await createSqliteVecLoader(); assert.ok(loader, 'declared sqlite-vec runtime required');
  const prepare = DatabaseSync.prototype.prepare;
  let missing = false;
  const mocked = t.mock.method(DatabaseSync.prototype, 'prepare', function(this: DatabaseSync, sql: string) {
    if (missing && sql.includes('vec_distance_cosine')) throw new Error('missing vector distance API');
    const statement = prepare.call(this, sql);
    if (sql === 'SELECT vec_version() AS version') return new Proxy(statement, { get(target, property) {
      if (property === 'get') return () => ({ version: 'v99.0.0' });
      const value = Reflect.get(target, property, target); return typeof value === 'function' ? value.bind(target) : value;
    } });
    return statement;
  });
  t.after(() => mocked.mock.restore());
  const db = openConnection(':memory:', { sqliteVecLoader: loader }); t.after(() => db.close());
  const capability = detectSqliteVecCapability(db); assert.equal(capability.available, true); assert.equal(capability.version, 'v99.0.0');
  const vector = new Uint8Array(new Float32Array([1, 0]).buffer);
  const orthogonal = new Uint8Array(new Float32Array([0, 1]).buffer);
  assert.equal(db.prepare('SELECT vec_distance_cosine(?, ?) AS distance').get(vector, orthogonal)?.distance, 1);
  missing = true;
  assert.equal(detectSqliteVecCapability(db).available, false);
  assert.throws(() => openConnection(':memory:', { sqliteVecLoader: loader }), SqliteVecLoadError);
});
