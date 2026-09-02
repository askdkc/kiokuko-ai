import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { openConnection } from '../../src/db/connection.js';
import { migrateDatabase } from '../../src/db/migrate.js';
import { LedgerStore } from '../../src/ledger/store.js';
import { recordEntry } from '../../src/memory/entries.js';
import { promoteLedgerProposal, promoteLedgerProposalInTransaction } from '../../src/ledger/promotion.js';

const now = '2026-08-20T00:00:00.000Z';
const migrations = path.resolve(import.meta.dirname, '../../migrations');

async function setup() {
  const directory = await mkdtemp(path.join(tmpdir(), 'kiokuko-ledger-promotion-'));
  const database = openConnection(path.join(directory, 'data.sqlite3'));
  migrateDatabase(database, migrations);
  return database;
}

function runInput(runId = 'run-1', workspace = 'workspace-1') {
  return {
    runId,
    workspace,
    protocolVersion: '1' as const,
    client: { kind: 'generic', version: '1.0.0' },
    captureProfile: 'standard' as const,
    coverage: { run: 'complete' as const, tool: 'best_effort' as const, command: 'declared' as const, file: 'unavailable' as const, approval: 'unavailable' as const },
    task: { title: 'Task', query: 'Promote a memory proposal', profileHints: { taskType: 'build' as const, target: null, expected: null, constraints: null } },
    startedAt: now,
  };
}

function seedProposal(database: ReturnType<typeof openConnection>, proposal: Record<string, unknown>, runId = 'run-1', workspace = 'workspace-1', proposalEventId = 'proposal-1') {
  const store = new LedgerStore(database, { now: () => now });
  store.createRun(runInput(runId, workspace));
  store.appendBatch(runId, {
    events: [{ eventId: proposalEventId, eventType: 'memory.proposed', actor: 'agent', occurredAt: now, payload: proposal }],
  });
}

test('promotes one explicit sanitized proposal as an untrusted candidate with a ledger link', async () => {
  const database = await setup();
  try {
    seedProposal(database, {
      kind: 'lesson',
      title: 'Stable test boundary',
      body: 'Keep the ledger separate from curated memory.',
      summary: 'A bounded lesson',
      scope: { project: 'kiokuko' },
      tags: ['ledger', 'policy'],
    });

    const result = promoteLedgerProposal(database, {
      workspace: 'workspace-1',
      runId: 'run-1',
      proposalEventId: 'proposal-1',
      actor: 'explicit-user',
      createdAt: now,
      confirmed: true,
    });

    assert.equal(result.untrusted, true);
    assert.equal(result.entry.status, 'candidate');
    assert.equal(result.entry.trustLevel, 'untrusted');
    assert.equal(result.entry.confidence, 0.25);
    assert.equal(result.entry.createdBy, 'explicit-user');
    assert.equal(result.entry.title, 'Stable test boundary');
    assert.equal(result.entry.body, 'Keep the ledger separate from curated memory.');
    assert.deepEqual(result.entry.tags, ['ledger', 'policy']);
    assert.equal(result.entry.provenance.type, 'ledger_promotion');
    assert.deepEqual(JSON.parse(result.entry.provenance.reference as string), {
      eventId: 'proposal-1',
      runId: 'run-1',
    });
    assert.equal(result.link.untrusted, true);
    assert.equal(result.link.runId, 'run-1');
    assert.equal(result.link.eventId, 'proposal-1');
    assert.equal(result.link.deliveryId, null);
    assert.equal(result.link.entryId, result.entry.id);
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM entries').get<{ count: number }>()?.count, 1);
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM audit_events').get<{ count: number }>()?.count, 1);
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM ledger_memory_links').get<{ count: number }>()?.count, 1);
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM ledger_events').get<{ count: number }>()?.count, 1);
  } finally {
    database.close();
  }
});

test('hides a cross-workspace proposal behind a fixed not-found error', async () => {
  const database = await setup();
  try {
    seedProposal(database, { kind: 'lesson', title: 'Private proposal title', body: 'Private proposal body.' }, 'run-1', 'workspace-2', 'foreign-proposal');

    assert.throws(() => promoteLedgerProposal(database, {
      workspace: 'workspace-1',
      runId: 'run-1',
      proposalEventId: 'foreign-proposal',
      actor: 'explicit-user',
      createdAt: now,
      confirmed: true,
    }), (error: unknown) => {
      assert.equal((error as { code?: string }).code, 'NOT_FOUND');
      assert.equal((error as Error).message, 'Ledger proposal not found');
      assert.equal((error as Error).message.includes('foreign-proposal'), false);
      assert.equal((error as Error).message.includes('Private proposal body'), false);
      return true;
    });
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM entries').get<{ count: number }>()?.count, 0);
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM ledger_memory_links').get<{ count: number }>()?.count, 0);
  } finally {
    database.close();
  }
});

test('hides a non-proposal ledger event behind the same not-found error', async () => {
  const database = await setup();
  try {
    const store = new LedgerStore(database, { now: () => now });
    store.createRun(runInput());
    store.appendBatch('run-1', {
      events: [{ eventId: 'wrong-type-event', eventType: 'tool.completed', actor: 'agent', occurredAt: now, payload: { kind: 'lesson', title: 'Not eligible', body: 'Not eligible.' } }],
    });

    assert.throws(() => promoteLedgerProposal(database, {
      workspace: 'workspace-1',
      runId: 'run-1',
      proposalEventId: 'wrong-type-event',
      actor: 'explicit-user',
      createdAt: now,
      confirmed: true,
    }), (error: unknown) => {
      assert.equal((error as { code?: string }).code, 'NOT_FOUND');
      assert.equal((error as Error).message, 'Ledger proposal not found');
      return true;
    });
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM entries').get<{ count: number }>()?.count, 0);
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM ledger_memory_links').get<{ count: number }>()?.count, 0);
  } finally {
    database.close();
  }
});

test('rejects unknown proposal fields before storing candidate content', async () => {
  const database = await setup();
  try {
    seedProposal(database, { kind: 'lesson', title: 'Allowlist title', body: 'Allowlist body.', untrustedExtra: 'do not promote' });

    assert.throws(() => promoteLedgerProposal(database, {
      workspace: 'workspace-1', runId: 'run-1', proposalEventId: 'proposal-1', actor: 'explicit-user', createdAt: now, confirmed: true,
    }), (error: unknown) => {
      assert.equal((error as { code?: string }).code, 'VALIDATION_ERROR');
      assert.equal((error as Error).message, 'Invalid memory proposal');
      assert.equal((error as Error).message.includes('do not promote'), false);
      return true;
    });
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM entries').get<{ count: number }>()?.count, 0);
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM audit_events').get<{ count: number }>()?.count, 0);
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM ledger_memory_links').get<{ count: number }>()?.count, 0);
  } finally {
    database.close();
  }
});

test('rejects an oversized proposal before opening promotion writes', async () => {
  const database = await setup();
  try {
    seedProposal(database, { kind: 'lesson', title: 'Oversized fixture', body: 'small' });
    database.prepare('UPDATE ledger_events SET payload_json = ? WHERE event_id = ?').run(
      JSON.stringify({ kind: 'lesson', title: 'Oversized fixture', body: 'x'.repeat(64 * 1024) }),
      'proposal-1',
    );

    assert.throws(() => promoteLedgerProposal(database, {
      workspace: 'workspace-1', runId: 'run-1', proposalEventId: 'proposal-1', actor: 'explicit-user', createdAt: now, confirmed: true,
    }), (error: unknown) => {
      assert.equal((error as { code?: string }).code, 'VALIDATION_ERROR');
      assert.equal((error as Error).message, 'Invalid memory proposal');
      return true;
    });
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM entries').get<{ count: number }>()?.count, 0);
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM audit_events').get<{ count: number }>()?.count, 0);
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM ledger_memory_links').get<{ count: number }>()?.count, 0);
  } finally {
    database.close();
  }
});

test('rejects a malformed proposal without creating memory or audit rows', async () => {
  const database = await setup();
  try {
    seedProposal(database, { kind: 'lesson', title: 'Missing body' });

    assert.throws(() => promoteLedgerProposal(database, {
      workspace: 'workspace-1', runId: 'run-1', proposalEventId: 'proposal-1', actor: 'explicit-user', createdAt: now, confirmed: true,
    }), (error: unknown) => {
      assert.equal((error as { code?: string }).code, 'VALIDATION_ERROR');
      assert.equal((error as Error).message, 'Invalid memory proposal');
      return true;
    });
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM entries').get<{ count: number }>()?.count, 0);
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM audit_events').get<{ count: number }>()?.count, 0);
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM ledger_memory_links').get<{ count: number }>()?.count, 0);
  } finally {
    database.close();
  }
});

test('rejects secret-like proposal text without echoing the secret or writing memory', async () => {
  const database = await setup();
  try {
    seedProposal(database, { kind: 'lesson', title: 'Secret fixture', body: 'safe before corruption' });
    const secret = 'password = hidden-secret-value-12345';
    database.prepare('UPDATE ledger_events SET payload_json = ? WHERE event_id = ?').run(JSON.stringify({ kind: 'lesson', title: 'Secret fixture', body: secret }), 'proposal-1');

    assert.throws(() => promoteLedgerProposal(database, {
      workspace: 'workspace-1', runId: 'run-1', proposalEventId: 'proposal-1', actor: 'explicit-user', createdAt: now, confirmed: true,
    }), (error: unknown) => {
      assert.equal((error as { code?: string }).code, 'SECURITY_REJECTION');
      assert.equal((error as Error).message, 'Proposal content was rejected by memory security policy');
      assert.equal((error as Error).message.includes(secret), false);
      return true;
    });
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM entries').get<{ count: number }>()?.count, 0);
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM audit_events').get<{ count: number }>()?.count, 0);
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM ledger_memory_links').get<{ count: number }>()?.count, 0);
  } finally {
    database.close();
  }
});

test('records same-run delivery provenance without duplicating the memory body', async () => {
  const database = await setup();
  try {
    seedProposal(database, { kind: 'lesson', title: 'Delivery-linked lesson', body: 'Delivery does not own this body.' });
    database.prepare(`
      INSERT INTO context_deliveries (
        delivery_id, run_id, through_sequence, intake_session_id, task_profile_hash, query_hash,
        policy_version, external_sync_summary_json, char_budget, char_count, truncated, created_at
      ) VALUES (?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run('delivery-1', 'run-1', 1, 'profile-hash', 'query-hash', 'policy-v1', '{}', 8000, 0, 0, now);

    const result = promoteLedgerProposal(database, {
      workspace: 'workspace-1', runId: 'run-1', proposalEventId: 'proposal-1', deliveryId: 'delivery-1', actor: 'explicit-user', createdAt: now, confirmed: true,
    });

    assert.equal(result.link.deliveryId, 'delivery-1');
    assert.deepEqual(JSON.parse(result.entry.provenance.reference as string), {
      deliveryId: 'delivery-1',
      eventId: 'proposal-1',
      runId: 'run-1',
    });
    assert.equal((result.entry.provenance.reference as string).includes('Delivery does not own this body.'), false);
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM ledger_memory_links WHERE delivery_id = ?').get<{ count: number }>('delivery-1')?.count, 1);
  } finally {
    database.close();
  }
});

test('rejects delivery provenance from another run before writing a candidate', async () => {
  const database = await setup();
  try {
    seedProposal(database, { kind: 'lesson', title: 'Run one lesson', body: 'Run one body.' }, 'run-1', 'workspace-1', 'proposal-1');
    const store = new LedgerStore(database, { now: () => now });
    store.createRun(runInput('run-2', 'workspace-1'));
    database.prepare(`
      INSERT INTO context_deliveries (
        delivery_id, run_id, through_sequence, intake_session_id, task_profile_hash, query_hash,
        policy_version, external_sync_summary_json, char_budget, char_count, truncated, created_at
      ) VALUES (?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run('foreign-delivery', 'run-2', 1, 'profile-hash', 'query-hash', 'policy-v1', '{}', 8000, 0, 0, now);

    assert.throws(() => promoteLedgerProposal(database, {
      workspace: 'workspace-1', runId: 'run-1', proposalEventId: 'proposal-1', deliveryId: 'foreign-delivery', actor: 'explicit-user', createdAt: now, confirmed: true,
    }), (error: unknown) => {
      assert.equal((error as { code?: string }).code, 'NOT_FOUND');
      assert.equal((error as Error).message, 'Ledger proposal not found');
      return true;
    });
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM entries').get<{ count: number }>()?.count, 0);
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM ledger_memory_links').get<{ count: number }>()?.count, 0);
  } finally {
    database.close();
  }
});

test('rejects a same-run delivery that predates the selected proposal', async () => {
  const database = await setup();
  try {
    seedProposal(database, { kind: 'lesson', title: 'Too-old delivery', body: 'The delivery predates this proposal.' });
    database.prepare(`
      INSERT INTO context_deliveries (
        delivery_id, run_id, through_sequence, intake_session_id, task_profile_hash, query_hash,
        policy_version, external_sync_summary_json, char_budget, char_count, truncated, created_at
      ) VALUES (?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run('old-delivery', 'run-1', 0, 'profile-hash', 'query-hash', 'policy-v1', '{}', 8000, 0, 0, now);

    assert.throws(() => promoteLedgerProposal(database, {
      workspace: 'workspace-1', runId: 'run-1', proposalEventId: 'proposal-1', deliveryId: 'old-delivery', actor: 'explicit-user', createdAt: now, confirmed: true,
    }), (error: unknown) => {
      assert.equal((error as { code?: string }).code, 'CONFLICT');
      assert.equal((error as Error).message, 'Ledger promotion conflicts with existing provenance');
      return true;
    });
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM entries').get<{ count: number }>()?.count, 0);
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM ledger_memory_links').get<{ count: number }>()?.count, 0);
  } finally {
    database.close();
  }
});

test('exact replay returns the same candidate and link without duplicates', async () => {
  const database = await setup();
  try {
    seedProposal(database, { kind: 'lesson', title: 'Replay-safe lesson', body: 'Replay-safe body.', tags: ['stable'] });
    const input = { workspace: 'workspace-1', runId: 'run-1', proposalEventId: 'proposal-1', actor: 'explicit-user', createdAt: now, confirmed: true };
    const first = promoteLedgerProposal(database, input);
    const replay = promoteLedgerProposal(database, input);

    assert.equal(replay.entry.id, first.entry.id);
    assert.equal(replay.link.linkId, first.link.linkId);
    assert.deepEqual(replay.entry, first.entry);
    assert.deepEqual(replay.link, first.link);
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM entries').get<{ count: number }>()?.count, 1);
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM audit_events').get<{ count: number }>()?.count, 1);
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM ledger_memory_links').get<{ count: number }>()?.count, 1);
  } finally {
    database.close();
  }
});

test('conflicts when the same candidate content is tied to a different event identity', async () => {
  const database = await setup();
  try {
    const proposal = { kind: 'lesson', title: 'One candidate only', body: 'The same content cannot gain a second source link.' };
    seedProposal(database, proposal);
    const store = new LedgerStore(database, { now: () => now });
    store.appendBatch('run-1', {
      events: [{ eventId: 'proposal-2', eventType: 'memory.proposed', actor: 'agent', occurredAt: now, payload: proposal }],
    });
    promoteLedgerProposal(database, { workspace: 'workspace-1', runId: 'run-1', proposalEventId: 'proposal-1', actor: 'explicit-user', createdAt: now, confirmed: true });

    assert.throws(() => promoteLedgerProposal(database, {
      workspace: 'workspace-1', runId: 'run-1', proposalEventId: 'proposal-2', actor: 'explicit-user', createdAt: now, confirmed: true,
    }), (error: unknown) => {
      assert.equal((error as { code?: string }).code, 'CONFLICT');
      assert.equal((error as Error).message, 'Ledger promotion conflicts with existing provenance');
      return true;
    });
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM entries').get<{ count: number }>()?.count, 1);
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM ledger_memory_links').get<{ count: number }>()?.count, 1);
  } finally {
    database.close();
  }
});

test('conflicts with an existing verified entry instead of downgrading it', async () => {
  const database = await setup();
  try {
    recordEntry(database, {
      workspace: 'workspace-1', kind: 'lesson', status: 'verified', title: 'Already verified', body: 'This content is already curated.',
      trustLevel: 'source_verified', confidence: 0.9, createdBy: 'reviewer', actor: 'reviewer', provenance: { type: 'manual', reference: 'review' },
    }, { now });
    seedProposal(database, { kind: 'lesson', title: 'Already verified', body: 'This content is already curated.' });

    assert.throws(() => promoteLedgerProposal(database, {
      workspace: 'workspace-1', runId: 'run-1', proposalEventId: 'proposal-1', actor: 'explicit-user', createdAt: now, confirmed: true,
    }), (error: unknown) => {
      assert.equal((error as { code?: string }).code, 'CONFLICT');
      assert.equal((error as Error).message, 'Ledger promotion conflicts with existing provenance');
      return true;
    });
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM entries').get<{ count: number }>()?.count, 1);
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM ledger_memory_links').get<{ count: number }>()?.count, 0);
    assert.equal(database.prepare("SELECT status, trust_level FROM entries WHERE workspace = 'workspace-1'").get<{ status: string; trust_level: string }>()?.status, 'verified');
  } finally {
    database.close();
  }
});

test('rejects caller-controlled status, trust, confidence, and provenance fields', async () => {
  const database = await setup();
  try {
    seedProposal(database, {
      kind: 'lesson', title: 'Fixed policy', body: 'The server owns promotion policy.',
      status: 'verified', trustLevel: 'system_verified', confidence: 1, createdBy: 'attacker', provenance: { type: 'attacker', reference: 'attacker' },
    });

    assert.throws(() => promoteLedgerProposal(database, {
      workspace: 'workspace-1', runId: 'run-1', proposalEventId: 'proposal-1', actor: 'explicit-user', createdAt: now, confirmed: true,
    }), (error: unknown) => {
      assert.equal((error as { code?: string }).code, 'VALIDATION_ERROR');
      assert.equal((error as Error).message, 'Invalid memory proposal');
      return true;
    });
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM entries').get<{ count: number }>()?.count, 0);
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM ledger_memory_links').get<{ count: number }>()?.count, 0);
  } finally {
    database.close();
  }
});

test('promotes explicitly from a completed run without appending or reopening ledger state', async () => {
  const database = await setup();
  try {
    seedProposal(database, { kind: 'lesson', title: 'Terminal run lesson', body: 'A completed run can still be promoted explicitly.' });
    const store = new LedgerStore(database, { now: () => now });
    store.updateRunStatus('run-1', 'completed', now);
    const before = database.prepare('SELECT status, last_sequence FROM ledger_runs WHERE run_id = ?').get<{ status: string; last_sequence: number }>('run-1');
    const eventCount = database.prepare('SELECT COUNT(*) AS count FROM ledger_events WHERE run_id = ?').get<{ count: number }>('run-1')?.count;

    const result = promoteLedgerProposal(database, {
      workspace: 'workspace-1', runId: 'run-1', proposalEventId: 'proposal-1', actor: 'explicit-user', createdAt: now, confirmed: true,
    });

    assert.equal(result.entry.status, 'candidate');
    assert.deepEqual(database.prepare('SELECT status, last_sequence FROM ledger_runs WHERE run_id = ?').get<{ status: string; last_sequence: number }>('run-1'), before);
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM ledger_events WHERE run_id = ?').get<{ count: number }>('run-1')?.count, eventCount);
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM ledger_events WHERE run_id = 'run-1' AND event_type = 'memory.promoted'").get<{ count: number }>()?.count, 0);
  } finally {
    database.close();
  }
});

test('caller-owned promotion rolls back entry, audit, and link with the outer transaction', async () => {
  const database = await setup();
  try {
    seedProposal(database, { kind: 'lesson', title: 'Outer transaction promotion', body: 'All three writes share one transaction.' });
    database.exec('BEGIN IMMEDIATE');
    const result = promoteLedgerProposalInTransaction(database, {
      workspace: 'workspace-1', runId: 'run-1', proposalEventId: 'proposal-1', actor: 'explicit-user', createdAt: now, confirmed: true,
    });
    assert.equal(result.entry.status, 'candidate');
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM entries').get<{ count: number }>()?.count, 1);
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM audit_events').get<{ count: number }>()?.count, 1);
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM ledger_memory_links').get<{ count: number }>()?.count, 1);
    database.exec('ROLLBACK');
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM entries').get<{ count: number }>()?.count, 0);
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM audit_events').get<{ count: number }>()?.count, 0);
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM ledger_memory_links').get<{ count: number }>()?.count, 0);
  } finally {
    try {
      database.exec('ROLLBACK');
    } catch {
      // The assertion path may already have rolled the outer transaction back.
    }
    database.close();
  }
});

test('standalone promotion rolls back entry and audit when the provenance link fails', async () => {
  const database = await setup();
  try {
    seedProposal(database, { kind: 'lesson', title: 'Atomic failure fixture', body: 'The link failure must not leak this entry.' });
    database.exec(`
      CREATE TRIGGER force_promotion_link_failure
      BEFORE INSERT ON ledger_memory_links
      WHEN NEW.event_id = 'proposal-1'
      BEGIN
        SELECT RAISE(ABORT, 'forced promotion link failure');
      END;
    `);

    assert.throws(() => promoteLedgerProposal(database, {
      workspace: 'workspace-1', runId: 'run-1', proposalEventId: 'proposal-1', actor: 'explicit-user', createdAt: now, confirmed: true,
    }), /forced promotion link failure/i);
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM entries').get<{ count: number }>()?.count, 0);
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM audit_events').get<{ count: number }>()?.count, 0);
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM ledger_memory_links').get<{ count: number }>()?.count, 0);
  } finally {
    database.close();
  }
});

test('requires explicit confirmation before any promotion write', async () => {
  const database = await setup();
  try {
    seedProposal(database, { kind: 'lesson', title: 'No implicit approval', body: 'This must not be stored.' });

    assert.throws(() => promoteLedgerProposal(database, {
      workspace: 'workspace-1',
      runId: 'run-1',
      proposalEventId: 'proposal-1',
      actor: 'explicit-user',
      createdAt: now,
    }), (error: unknown) => {
      assert.equal((error as { code?: string }).code, 'VALIDATION_ERROR');
      assert.equal((error as Error).message, 'Explicit promotion confirmation is required');
      assert.equal((error as Error).message.includes('proposal-1'), false);
      return true;
    });
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM entries').get<{ count: number }>()?.count, 0);
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM ledger_memory_links').get<{ count: number }>()?.count, 0);
  } finally {
    database.close();
  }
});
