import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { NodeSqliteAdapter } from '../../src/db/adapter.js';
import { attachRelationDelivery, configuredRelationDeliveryOptions, legacyRelationDelivery, packRelationDelivery, readRelationDelivery } from '../../src/memory/relation-delivery.js';

function fixture() {
  const database = new NodeSqliteAdapter(':memory:', new DatabaseSync(':memory:'));
  database.exec('CREATE TABLE entries(id TEXT PRIMARY KEY, workspace TEXT, current_revision INTEGER); CREATE TABLE entry_links(from_entry_id TEXT, to_entry_id TEXT, relation TEXT, PRIMARY KEY(from_entry_id,to_entry_id,relation));');
  for (const id of ['a', 'b', 'c']) database.prepare('INSERT INTO entries VALUES(?,?,1)').run(id, id === 'c' ? 'other' : 'project');
  const link = (from: string, to: string, type: string) => database.prepare('INSERT INTO entry_links VALUES(?,?,?)').run(from, to, type);
  return { database, link, items: [{ entryId: 'a', workspace: 'project', revision: 1 }, { entryId: 'b', workspace: 'project', revision: 1 }] };
}

test('delivers coexisting support and contradiction, preserves reverse derivation, excludes unprovided workspace', () => {
  const f = fixture();
  try {
    f.link('a', 'b', 'supports'); f.link('a', 'b', 'contradicts'); f.link('b', 'a', 'derived_from'); f.link('a', 'c', 'related_to');
    const result = readRelationDelivery(f.database, f.items);
    assert.equal(result.status, 'complete'); assert.equal(result.edges.length, 3);
    assert.ok(result.edges.some(edge => edge.type === 'derived_from' && edge.from.entryId === 'b' && edge.to.entryId === 'a'));
    assert.ok(result.edges.every(edge => edge.from.workspace === 'project' && edge.to.workspace === 'project'));
    assert.equal(readRelationDelivery(f.database, [f.items[0]!]).edges.length, 0);
  } finally { f.database.close(); }
});

test('budget and cap omissions are all-or-none, including a coexisting contradiction', () => {
  const f = fixture();
  try {
    f.link('a', 'b', 'supports'); f.link('a', 'b', 'contradicts');
    assert.deepEqual(readRelationDelivery(f.database, f.items, { relationEdgeCap: 1 }), { scope: 'provided_items', status: 'omitted_edge_cap', edges: [], selectionOmissions: [] });
    assert.equal(readRelationDelivery(f.database, f.items, { relationEdgeCap: 2 }).status, 'complete');
    const complete = readRelationDelivery(f.database, f.items), boundary = Array.from(JSON.stringify({ relationDelivery: complete })).length;
    assert.equal(readRelationDelivery(f.database, f.items, { relationCharacterBudget: boundary }).status, 'complete');
    assert.deepEqual(readRelationDelivery(f.database, f.items, { relationCharacterBudget: boundary - 1 }), { scope: 'provided_items', status: 'omitted_budget', edges: [], selectionOmissions: [] });
    assert.throws(() => readRelationDelivery(f.database, f.items, { relationCharacterBudget: 1 }), /cannot fit/u);
  } finally { f.database.close(); }
});

test('unknown stored types never produce complete or a partial known-edge result', () => {
  const f = fixture();
  try { f.link('a', 'b', 'supports'); f.link('b', 'a', 'future_type');
    assert.deepEqual(readRelationDelivery(f.database, f.items), { scope: 'provided_items', status: 'omitted_unknown_type', edges: [], selectionOmissions: [] });
  } finally { f.database.close(); }
});

test('legacy and final filtering stay explicit without broadening complete beyond final endpoints', () => {
  assert.equal(legacyRelationDelivery().status, 'omitted_legacy');
  assert.deepEqual(legacyRelationDelivery({ selectionOmissions: ['final_filter'] }).selectionOmissions, ['final_filter']);
  assert.throws(() => legacyRelationDelivery({ relationCharacterBudget: 1 }), /cannot fit/u);
  const f = fixture();
  try {
    f.link('a', 'b', 'contradicts');
    const final = readRelationDelivery(f.database, [f.items[0]!], { selectionOmissions: ['final_filter'] });
    assert.equal(final.status, 'complete'); assert.deepEqual(final.edges, []);
    assert.deepEqual(final.selectionOmissions, ['final_filter']);
  } finally { f.database.close(); }
});

test('selection changes fail explicitly; empty selection and malformed limits remain distinct', () => {
  const f = fixture();
  try {
    f.database.prepare('UPDATE entries SET current_revision=2 WHERE id=?').run('a');
    assert.throws(() => readRelationDelivery(f.database, f.items), /changed/u);
    assert.equal(readRelationDelivery(f.database, []).status, 'complete');
    assert.throws(() => readRelationDelivery(f.database, [], { relationEdgeCap: 0 }), /limits/u);
    assert.throws(() => readRelationDelivery(f.database, [f.items[0]!, f.items[0]!]), /endpoints/u);
  } finally { f.database.close(); }
});

test('Unicode relation metadata counts code points and the packer does not mutate its input', () => {
  const row = { kind: 'edge', from_id: '😀', from_workspace: '日本', to_id: '𠮷', to_workspace: '日本', relation: 'contradicts' };
  const rows = Object.freeze([Object.freeze(row)]), result = packRelationDelivery(rows);
  const budget = Array.from(JSON.stringify({ relationDelivery: result })).length;
  assert.equal(packRelationDelivery(rows, { relationCharacterBudget: budget }).status, 'complete');
  assert.equal(packRelationDelivery(rows, { relationCharacterBudget: budget - 1 }).status, 'omitted_budget');
  assert.equal(rows[0], row);
});

test('large unrelated adjacency uses endpoint-pair index searches rather than scanning outgoing links', () => {
  const f = fixture();
  try {
    for (let i = 0; i < 5000; i++) f.link('a', 'outside-' + i, 'supports');
    f.link('b', 'a', 'contradicts');
    let plan = '';
    const database = { ...f.database, filePath: ':memory:', exec: f.database.exec.bind(f.database), close: () => {}, prepare(sql: string) {
      plan = JSON.stringify(f.database.prepare('EXPLAIN QUERY PLAN ' + sql).all('a', 'project', 1, 'b', 'project', 1, 129));
      return f.database.prepare(sql);
    } };
    assert.equal(readRelationDelivery(database, f.items).edges.length, 1);
    assert.match(plan, /SEARCH l USING COVERING INDEX .*from_entry_id=\? AND to_entry_id=\?/u);
    assert.doesNotMatch(plan, /SCAN l(?:\W|$)/u);
  } finally { f.database.close(); }
});

test('a separate WAL writer between presentation and link reads cannot produce a mixed complete response', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'relation-snapshot-')), filename = path.join(root, 'data.sqlite3');
  const reader = new NodeSqliteAdapter(filename, new DatabaseSync(filename));
  reader.exec("PRAGMA journal_mode=WAL; CREATE TABLE entries(id TEXT PRIMARY KEY, workspace TEXT, current_revision INTEGER); CREATE TABLE entry_links(from_entry_id TEXT,to_entry_id TEXT,relation TEXT,PRIMARY KEY(from_entry_id,to_entry_id,relation)); INSERT INTO entries VALUES('a','p',1),('b','p',1);");
  const writer = new NodeSqliteAdapter(filename, new DatabaseSync(filename));
  let changed = false;
  const database = { filePath: filename, exec: reader.exec.bind(reader), close() {}, prepare(sql: string) {
    if (sql.startsWith('WITH selected') && !changed) {
      changed = true;
      writer.exec("BEGIN IMMEDIATE; UPDATE entries SET current_revision=2 WHERE id='a'; INSERT INTO entry_links VALUES('a','b','contradicts'); COMMIT;");
    }
    return reader.prepare(sql);
  } };
  try {
    assert.throws(() => attachRelationDelivery(database, { items: [{ entryId: 'a', workspace: 'p', revision: 1 }, { entryId: 'b', workspace: 'p', revision: 1 }] }), /changed/u);
    const current = attachRelationDelivery(reader, { items: [{ entryId: 'a', workspace: 'p', revision: 2 }, { entryId: 'b', workspace: 'p', revision: 1 }] });
    assert.equal(current.relationDelivery.status, 'complete'); assert.equal(current.relationDelivery.edges[0]?.type, 'contradicts');
  } finally { writer.close(); reader.close(); rmSync(root, { recursive: true, force: true }); }
});

test('finite adapter settings are adjustable and explicit options override the environment', () => {
  const priorBudget = process.env.KIOKUKO_RELATION_CHARACTER_BUDGET, priorCap = process.env.KIOKUKO_RELATION_EDGE_CAP;
  try {
    process.env.KIOKUKO_RELATION_CHARACTER_BUDGET = '4096'; process.env.KIOKUKO_RELATION_EDGE_CAP = '7';
    assert.equal(configuredRelationDeliveryOptions().relationEdgeCap, 7);
    assert.equal(configuredRelationDeliveryOptions({ relationEdgeCap: 9 }).relationEdgeCap, 9);
    assert.equal(configuredRelationDeliveryOptions().relationCharacterBudget, 4096);
    process.env.KIOKUKO_RELATION_EDGE_CAP = '100000000'; assert.throws(() => configuredRelationDeliveryOptions(), /limits/u);
  } finally {
    if (priorBudget === undefined) delete process.env.KIOKUKO_RELATION_CHARACTER_BUDGET; else process.env.KIOKUKO_RELATION_CHARACTER_BUDGET = priorBudget;
    if (priorCap === undefined) delete process.env.KIOKUKO_RELATION_EDGE_CAP; else process.env.KIOKUKO_RELATION_EDGE_CAP = priorCap;
  }
});

 test('shared serialized envelope boundary includes the outer key, escaping and Unicode endpoints', () => {
  const fixture = JSON.parse(readFileSync(new URL('../fixtures/relation-envelope-boundary.json', import.meta.url), 'utf8'));
  assert.equal(JSON.stringify(fixture.envelope), fixture.serialized);
  assert.equal(Array.from(fixture.serialized).length, fixture.codePoints);
  const relation = fixture.envelope.relationDelivery;
  const rows = relation.edges.map((edge: {from:{entryId:string;workspace:string};to:{entryId:string;workspace:string};type:string}) => ({ kind: 'edge', from_id: edge.from.entryId, from_workspace: edge.from.workspace, to_id: edge.to.entryId, to_workspace: edge.to.workspace, relation: edge.type }));
  assert.deepEqual(packRelationDelivery(rows, { relationCharacterBudget: fixture.codePoints, selectionOmissions: relation.selectionOmissions }), relation);
  assert.equal(packRelationDelivery(rows, { relationCharacterBudget: fixture.codePoints - 1, selectionOmissions: relation.selectionOmissions }).status, 'omitted_budget');
 });
