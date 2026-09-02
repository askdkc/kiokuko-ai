import type { SqliteDatabase, SqliteRow } from '../db/adapter.js';
import { KiokukoError } from '../errors.js';
import { canonicalJson } from '../serialization/validate.js';
import { parseStrictJson } from '../setup/strict-json.js';
import { parseStoredAdvisoryContribution } from './schemas.js';
import {
  ADVISORY_PHASES,
  ADVISORY_POLICY_VERSION,
  type AdvisoryContribution,
  type AdvisoryPhase,
  type StoredAdvisoryRound,
} from './types.js';
import { advisoryRoundAggregate, normalizeAdvisoryContributions } from './advisory.js';

interface RoundRow extends SqliteRow {
  round_id: string;
  run_id: string;
  contract_revision: number;
  mutation_revision: number;
  phase: AdvisoryPhase;
  input_digest: string;
  policy_version: number;
  source: 'host_reported';
  state: StoredAdvisoryRound['state'];
  degraded: number;
  aggregate_json: string;
}

interface ContributionRow extends SqliteRow {
  contribution_json: string;
}

function roundRow(database: SqliteDatabase, input: {
  runId: string;
  contractRevision: number;
  mutationRevision: number;
  phase: AdvisoryPhase;
  inputDigest: string;
}): RoundRow | undefined {
  return database.prepare(`
    SELECT round_id, run_id, contract_revision, mutation_revision, phase,
           input_digest, policy_version, source, state, degraded, aggregate_json
    FROM enno_advisory_rounds
    WHERE run_id = ? AND contract_revision = ? AND mutation_revision = ?
      AND phase = ? AND input_digest = ?
  `).get<RoundRow>(input.runId, input.contractRevision, input.mutationRevision, input.phase, input.inputDigest);
}

function parseStoredRound(database: SqliteDatabase, row: RoundRow): StoredAdvisoryRound {
  if (row.policy_version !== ADVISORY_POLICY_VERSION || row.source !== 'host_reported' || !ADVISORY_PHASES.includes(row.phase)) {
    throw new KiokukoError('INTEGRITY_ERROR', 'Stored advisory round metadata is invalid');
  }
  const contributions = database.prepare(`
    SELECT contribution_json
    FROM enno_advisory_contributions
    WHERE round_id = ? ORDER BY slot_rank
  `).all<ContributionRow>(row.round_id).map((item) => {
    let parsed: unknown;
    try {
      parsed = parseStrictJson(
        item.contribution_json,
        { allowTrailingComma: false, disallowComments: true, allowEmptyContent: false },
        'Stored advisory contribution is invalid',
      );
    } catch {
      throw new KiokukoError('INTEGRITY_ERROR', 'Stored advisory contribution is invalid');
    }
    return parseStoredAdvisoryContribution(parsed);
  });
  const normalized = normalizeAdvisoryContributions(row.phase, contributions);
  const aggregate = advisoryRoundAggregate(normalized);
  if (Boolean(row.degraded) !== aggregate.degraded || canonicalJson(aggregate) !== row.aggregate_json) {
    throw new KiokukoError('INTEGRITY_ERROR', 'Stored advisory round aggregate is invalid');
  }
  return {
    phase: row.phase,
    contractRevision: row.contract_revision,
    mutationRevision: row.mutation_revision,
    inputDigest: row.input_digest,
    policyVersion: row.policy_version,
    source: row.source,
    state: row.state,
    degraded: aggregate.degraded,
    contributions: normalized,
  };
}

export function readAdvisoryRound(database: SqliteDatabase, input: {
  runId: string;
  contractRevision: number;
  mutationRevision: number;
  phase: AdvisoryPhase;
  inputDigest: string;
}): StoredAdvisoryRound | undefined {
  const row = roundRow(database, input);
  return row === undefined ? undefined : parseStoredRound(database, row);
}

export function readSubmittedAdvisoryRound(database: SqliteDatabase, input: {
  runId: string;
  contractRevision: number;
  mutationRevision: number;
  phase: AdvisoryPhase;
}): StoredAdvisoryRound | undefined {
  const row = database.prepare(`
    SELECT round_id, run_id, contract_revision, mutation_revision, phase,
           input_digest, policy_version, source, state, degraded, aggregate_json
    FROM enno_advisory_rounds
    WHERE run_id = ? AND contract_revision = ? AND mutation_revision = ? AND phase = ?
    ORDER BY created_at DESC, round_id DESC
    LIMIT 1
  `).get<RoundRow>(input.runId, input.contractRevision, input.mutationRevision, input.phase);
  return row === undefined ? undefined : parseStoredRound(database, row);
}

export function createAdvisoryRoundInTransaction(database: SqliteDatabase, input: {
  runId: string;
  contractRevision: number;
  mutationRevision: number;
  phase: AdvisoryPhase;
  inputDigest: string;
  contributions: readonly AdvisoryContribution[];
}): StoredAdvisoryRound {
  const normalized = normalizeAdvisoryContributions(input.phase, input.contributions);
  const aggregate = advisoryRoundAggregate(normalized);
  const now = new Date().toISOString();
  const roundId = `${input.runId}-${input.phase}-${input.contractRevision}-${input.mutationRevision}-${input.inputDigest.slice(0, 16)}`;
  database.prepare(`
    INSERT INTO enno_advisory_rounds (
      round_id, run_id, contract_revision, mutation_revision, phase,
      input_digest, policy_version, source, state, degraded, aggregate_json, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, 'host_reported', 'aggregated', ?, ?, ?, ?)
  `).run(
    roundId,
    input.runId,
    input.contractRevision,
    input.mutationRevision,
    input.phase,
    input.inputDigest,
    ADVISORY_POLICY_VERSION,
    aggregate.degraded ? 1 : 0,
    canonicalJson(aggregate),
    now,
    now,
  );
  const statement = database.prepare(`
    INSERT INTO enno_advisory_contributions (
      round_id, slot_id, slot_rank, outcome, contribution_json, created_at
    ) VALUES (?, ?, ?, ?, ?, ?)
  `);
  normalized.forEach((contribution, rank) => statement.run(
    roundId,
    contribution.slotId,
    rank,
    contribution.outcome,
    canonicalJson(contribution),
    now,
  ));
  const created = roundRow(database, input);
  if (created === undefined) throw new KiokukoError('INTEGRITY_ERROR', 'Advisory round was not persisted');
  return parseStoredRound(database, created);
}

export function ensureAdvisoryRoundConsumedInTransaction(database: SqliteDatabase, input: {
  runId: string;
  contractRevision: number;
  mutationRevision: number;
  phase: AdvisoryPhase;
  inputDigest: string;
}): StoredAdvisoryRound {
  const existing = roundRow(database, input);
  if (existing === undefined) throw new KiokukoError('CONFLICT', 'Required advisory round was not submitted');
  const round = parseStoredRound(database, existing);
  if (round.state === 'consumed') return round;
  const updated = database.prepare(`
    UPDATE enno_advisory_rounds
    SET state = 'consumed', updated_at = ?
    WHERE round_id = ? AND state = 'aggregated'
    RETURNING round_id
  `).get<{ round_id: string }>(new Date().toISOString(), existing.round_id);
  if (updated?.round_id !== existing.round_id) throw new KiokukoError('CONFLICT', 'Advisory round changed concurrently');
  return { ...round, state: 'consumed' };
}
