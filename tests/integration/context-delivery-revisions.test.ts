import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { openConnection } from '../../src/db/connection.js';
import { migrateDatabase } from '../../src/db/migrate.js';
import { recordEntry, updateCandidateEntry } from '../../src/memory/entries.js';
import { recordContextDelivery, readContextDelivery } from '../../src/context/delivery.js';
import { KiokukoError } from '../../src/errors.js';
import { canonicalContentHash, canonicalJson } from '../../src/serialization/validate.js';

const migrationsDirectory = path.resolve(import.meta.dirname, '../../migrations');
const now = '2026-08-22T00:00:00.000Z';
const taskProfile = { taskType: 'build', target: 'delivery', expected: 'delivery', constraints: null } as const;
const taskProfileHash = canonicalContentHash(taskProfile);
const genericDeliveryPolicyVersion = 'context-ranking-v1+recommendations.v1';
const scoreComponents = {
  status: 1, trust: 1, confidence: 1, taskAffinity: 1, recommendedTags: 0,
  pathOverlap: 0, errorSignature: 0, feedback: 0, recency: 0, contradiction: 0,
};

async function database() {
  const directory = await mkdtemp(path.join(tmpdir(), 'kiokuko-context-revisions-'));
  const db = openConnection(path.join(directory, 'data.sqlite3'));
  migrateDatabase(db, migrationsDirectory);
  db.prepare(`
    INSERT INTO ledger_runs (
      run_id, workspace, client_kind, client_version, source_session_id, parent_run_id,
      protocol_version, capture_profile, coverage_json, status, title, task_hash,
      metadata_json, last_sequence, last_source_sequence, started_at, ended_at, created_at, updated_at
    ) VALUES (?, ?, 'generic', '1.0.0', NULL, NULL, '1', 'standard', '{"approval":"unavailable","command":"unavailable","file":"unavailable","run":"declared","tool":"unavailable"}', 'active', 'delivery', NULL, '{}', 0, NULL, ?, NULL, ?, ?)
  `).run('run-context-revisions', 'project:context-revisions', now, now, now);
  db.prepare(`
    INSERT INTO akinator_sessions (
      id, workspace, task_text, profile_json, status, question_count, created_at, updated_at
    ) VALUES (?, ?, 'delivery', ?, 'ready', 0, ?, ?)
  `).run(
    'session-context-revisions',
    'project:context-revisions',
    canonicalJson(taskProfile),
    now,
    now,
  );
  db.prepare(`
    INSERT INTO run_intakes (
      run_id, session_id, policy_version, profile_schema_version, profile_sources_json,
      initial_profile_hash, recommended_tags_json, linked_at, finalized_at
    ) VALUES (?, ?, 'v2', 1, ?, ?, ?, ?, ?)
  `).run(
    'run-context-revisions',
    'session-context-revisions',
    canonicalJson({ taskType: 'client_supplied', target: 'client_supplied', expected: 'client_supplied', constraints: 'client_supplied' }),
    taskProfileHash,
    canonicalJson(['bot:builder', 'skill:tdd']),
    now,
    now,
  );
  return db;
}

function delivery(db: ReturnType<typeof openConnection>, deliveryId: string, entryId: string, entryRevision: number) {
  return recordContextDelivery(db, {
    workspace: 'project:context-revisions',
    deliveryId,
    runId: 'run-context-revisions',
    throughSequence: 0,
    intakeSessionId: 'session-context-revisions',
    taskProfileHash,
    queryHash: 'b'.repeat(64),
    policyVersion: genericDeliveryPolicyVersion,
    charBudget: 8000,
    charCount: 10,
    truncated: false,
    createdAt: now,
    items: [{ entryId, entryRevision, rank: 1, scoreComponents, selectionReasons: ['verified'] }],
  });
}

test('context deliveries retain exact historical entry revisions', async () => {
  const db = await database();
  try {
    const first = recordEntry(db, { workspace: 'project:context-revisions', kind: 'lesson', title: 'revision one', body: 'old body', tags: ['old'] });
    const firstDelivery = delivery(db, 'delivery-revision-1', first.id, 1);
    const second = updateCandidateEntry(db, { workspace: first.workspace, entryId: first.id, expectedRevision: 1, kind: 'lesson', title: 'revision two', body: 'new body', tags: ['new'] });
    assert.equal(firstDelivery.items[0]?.entryRevision, 1);
    assert.equal(readContextDelivery(db, { workspace: first.workspace, deliveryId: firstDelivery.deliveryId }).items[0]?.entryRevision, 1);
    assert.equal(db.prepare('SELECT body FROM entry_revisions WHERE entry_id = ? AND revision = 1').get<{ body: string }>(first.id)?.body, 'old body');

    const secondDelivery = delivery(db, 'delivery-revision-2', first.id, second.revision);
    assert.equal(secondDelivery.items[0]?.entryRevision, 2);
    assert.deepEqual(db.prepare('SELECT delivery_id, entry_revision, origin_scope FROM context_delivery_entries ORDER BY delivery_id').all().map((row) => ({ ...row as Record<string, unknown> })), [
      { delivery_id: 'delivery-revision-1', entry_revision: 1, origin_scope: 'project' },
      { delivery_id: 'delivery-revision-2', entry_revision: 2, origin_scope: 'project' },
    ]);
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
    assert.equal(db.prepare('PRAGMA integrity_check').get<{ integrity_check: string }>()?.integrity_check, 'ok');
  } finally {
    db.close();
  }
});

test('a delivery cannot reference a missing revision', async () => {
  const db = await database();
  try {
    const entry = recordEntry(db, { workspace: 'project:context-revisions', kind: 'fact', title: 'entry', body: 'body' });
    assert.throws(() => delivery(db, 'delivery-missing-revision', entry.id, 99), (error) => error instanceof KiokukoError && error.code === 'NOT_FOUND');
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM context_deliveries').get<{ count: number }>()?.count, 0);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM context_delivery_entries').get<{ count: number }>()?.count, 0);
  } finally {
    db.close();
  }
});
