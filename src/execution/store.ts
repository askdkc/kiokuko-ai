import * as z from 'zod/v4';
import type { SqliteDatabase } from '../db/adapter.js';
import { withImmediateTransaction } from '../db/transaction.js';
import { KiokukoError } from '../errors.js';
import { LedgerStore } from '../ledger/store.js';
import { canonicalContentHash, canonicalJson } from '../serialization/validate.js';
import { findSecretInValue } from '../memory/secrets.js';
import { canonicalDirectory } from '../repository/detect-root.js';
import { detectRepositoryRoot } from '../repository/detect-root.js';
import {
  EXECUTION_ROLES, EXECUTION_PRESETS, EXECUTION_SELECTION_INSTRUCTIONS,
  executionCatalogSchema, roleSelectionSchema, candidateSchema,
  type ExecutionCatalog, type ExecutionRole,
} from './catalog.js';

const identity = z.string().min(1).max(256).refine(value => value.trim() === value && !/[\p{Cc}\p{Cf}]/u.test(value));
export const executionSelectSchema = z.object({
  runId: identity, expectedRevision: z.number().int().min(0), idempotencyKey: identity,
  choice: z.enum(['ordinary', 'enno', 'cancelled']),
  preset: z.string().max(100).optional(), agents: roleSelectionSchema.partial().optional(),
  cwd: z.string().min(1).max(4096).optional(),
  catalog: executionCatalogSchema.optional().describe('OpenCode plugin supplied current catalog; do not fabricate availability'),
}).strict();
export type ExecutionSelectInput = z.infer<typeof executionSelectSchema>;
const selectionSchema = z.object(Object.fromEntries(EXECUTION_ROLES.map(role => [role, candidateSchema])) as Record<ExecutionRole, typeof candidateSchema>).strict();
export type SelectedExecution = z.infer<typeof selectionSchema>;
export type ExecutionRouting = Pick<NonNullable<ReturnType<typeof executionView>>, 'runId' | 'revision' | 'selected' | 'dispatch'>;
type Row = { run_id: string; revision: number; choice: 'legacy' | 'pending' | 'ordinary' | 'enno' | 'cancelled'; catalog_json: string; selected_json: string | null; prepared_json: string };
export function readExecutionRow(db: SqliteDatabase, runId: string): Row | undefined {
  return db.prepare('SELECT * FROM task_execution_selections WHERE run_id = ?').get<Row>(runId);
}
export function selectedExecution(row: Row): SelectedExecution | null {
  return row.selected_json === null ? null : selectionSchema.parse(JSON.parse(row.selected_json));
}
export function initializeExecution(db: SqliteDatabase, runId: string, input: ExecutionCatalog): void {
  const catalog = executionCatalogSchema.parse(input);
  if (findSecretInValue(catalog) !== undefined) throw new KiokukoError('VALIDATION_ERROR', 'Execution catalog contains unsafe data');
  db.prepare(`INSERT INTO task_execution_selections(run_id, choice, catalog_json, prepared_json)
    VALUES (?, ?, ?, '{}') ON CONFLICT(run_id) DO NOTHING`).run(runId, catalog.mode === 'off' ? 'ordinary' : 'pending', canonicalJson(catalog));
}
export function saveExecutionPreparation(db: SqliteDatabase, runId: string, prepared: unknown): void {
  db.prepare('UPDATE task_execution_selections SET prepared_json = ? WHERE run_id = ?').run(canonicalJson(prepared), runId);
}
export function executionView(db: SqliteDatabase, runId: string, availableCatalog?: ExecutionCatalog) {
  const row = readExecutionRow(db, runId);
  if (row === undefined || row.choice === 'legacy') return null; // Existing runs retain the pre-selection protocol.
  const selected = selectedExecution(row);
  const catalog = availableCatalog ?? executionCatalogSchema.parse(JSON.parse(row.catalog_json));
  return {
    runId, revision: row.revision, choice: row.choice, mode: catalog.mode,
    modelFailure: hasExecutionFailure(db, runId, row.revision),
    instructions: EXECUTION_SELECTION_INSTRUCTIONS,
    candidates: catalog.candidates,
    presets: EXECUTION_PRESETS.map(preset => ({ id: preset.id, agents: preset.agents,
      available: EXECUTION_ROLES.every(role => catalog.candidates.some(c => c.role === role && c.agent === preset.agents[role] && c.unavailable === null)),
      unavailable: EXECUTION_ROLES.flatMap(role => {
        const candidate = catalog.candidates.find(c => c.role === role && c.agent === preset.agents[role]);
        return candidate?.unavailable === null ? [] : [{ role, reason: candidate?.unavailable ?? 'agent_missing' }];
      }),
    })),
    selected,
    dispatch: selected === null ? null : Object.fromEntries(EXECUTION_ROLES.map(role => [role, {
      subagent_type: selected[role].agent,
      promptPrefix: `<kiokuko-execution>${JSON.stringify({ runId, revision: row.revision, role })}</kiokuko-execution>\n`,
    }])),
  };
}

/** Validate repository ownership before returning any persisted routing state. */
export function requireExecutionRun(db: SqliteDatabase, runId: string, cwd: string, rootSessionId?: string) {
  const row = readExecutionRow(db, runId);
  const run = new LedgerStore(db).readRun(runId);
  if (!row || !run) throw new KiokukoError('NOT_FOUND', 'Execution selection was not found');
  const prepared = JSON.parse(row.prepared_json) as { project?: { repositoryRoot?: string; workspace?: string } };
  const root = canonicalDirectory(detectRepositoryRoot({ cwd }).root);
  const owner = db.prepare('SELECT client_session_id FROM enno_contracts WHERE run_id = ?').get<{ client_session_id: string | null }>(runId)?.client_session_id ?? run.client.sessionId;
  if (prepared.project?.repositoryRoot !== root || prepared.project.workspace !== run.workspace
    || (rootSessionId !== undefined && owner !== rootSessionId)) {
    throw new KiokukoError('CONFLICT', 'Execution selection repository or session does not match');
  }
  return { row, run };
}

function hasExecutionFailure(db: SqliteDatabase, runId: string, revision: number): boolean {
  return db.prepare("SELECT 1 FROM task_execution_dispatches WHERE run_id = ? AND revision = ? AND status = 'failed' LIMIT 1").get(runId, revision) !== undefined;
}

export const executionReadSchema = z.object({ runId: identity, rootSessionId: identity, cwd: z.string().min(1).max(4096) }).strict();
export function readExecutionRouting(db: SqliteDatabase, input: z.infer<typeof executionReadSchema>) {
  const { row, run } = requireExecutionRun(db, input.runId, input.cwd, input.rootSessionId);
  const contract = db.prepare('SELECT status, phase FROM enno_contracts WHERE run_id = ?').get<{ status: string; phase: string | null }>(input.runId);
  const status = contract?.phase ?? contract?.status;
  const role: ExecutionRole | null = status === 'oduno_ideal' ? 'ideal' : status === 'zenki_planning' ? 'zenki'
    : status === 'goki_executing' ? 'gokiHead' : status === 'enno_verifying' || status === 'oduno_meditation' ? 'check' : null;
  return { runId: input.runId, revision: row.revision, choice: row.choice, active: ['intake', 'active'].includes(run.status),
    role, selected: selectedExecution(row), modelFailure: hasExecutionFailure(db, input.runId, row.revision) };
}

export class ExecutionUnavailableError extends KiokukoError {
  constructor(readonly reason: string, readonly role: ExecutionRole | null, readonly catalog: ExecutionCatalog) {
    super('CONFLICT', `Execution candidate unavailable: ${reason}. Select another model, ordinary work, or cancel.`);
  }
}

export function selectExecution(db: SqliteDatabase, raw: ExecutionSelectInput, cwd: string) {
  const input = executionSelectSchema.parse(raw);
  if (findSecretInValue(input) !== undefined) throw new KiokukoError('VALIDATION_ERROR', 'Execution selection contains unsafe data');
  return withImmediateTransaction(db, () => {
    const { row, run } = requireExecutionRun(db, input.runId, cwd);
    const operationId = canonicalContentHash(input.idempotencyKey);
    // A transport retry must not depend on a newly fetched availability catalog.
    const digest = canonicalContentHash({ choice: input.choice, expectedRevision: input.expectedRevision, preset: input.preset ?? null, agents: input.agents ?? null });
    const receipt = db.prepare('SELECT input_digest, revision FROM task_execution_receipts WHERE run_id = ? AND operation_id = ?')
      .get<{ input_digest: string; revision: number }>(input.runId, operationId);
    if (receipt) {
      if (receipt.input_digest !== digest || receipt.revision !== row.revision) throw new KiokukoError('CONFLICT', 'Execution selection retry is stale or changed');
      return executionView(db, input.runId)!;
    }
    if (!['intake', 'active'].includes(run.status) || row.choice === 'legacy' || row.choice === 'cancelled' || input.expectedRevision !== row.revision) {
      throw new KiokukoError('CONFLICT', 'Execution selection is terminal or its revision changed');
    }
    if (db.prepare('SELECT run_id FROM enno_execution_leases WHERE run_id = ? AND lease_expires_at > ? LIMIT 1').get(input.runId, new Date().toISOString())) {
      throw new KiokukoError('CONFLICT', 'Finish or stop the active WorkUnit before changing execution selection');
    }
    const catalog = input.catalog ?? executionCatalogSchema.parse(JSON.parse(row.catalog_json));
    let selected: SelectedExecution | null = null;
    if (input.choice === 'enno') {
      if (catalog.mode === 'off') throw new ExecutionUnavailableError('disabled', null, catalog);
      const preset = input.preset === undefined ? undefined : EXECUTION_PRESETS.find(p => p.id === input.preset);
      if (input.preset !== undefined && !preset) throw new KiokukoError('VALIDATION_ERROR', 'Unknown execution preset');
      const previous = selectedExecution(row);
      const agents = roleSelectionSchema.parse({ ...(previous && Object.fromEntries(EXECUTION_ROLES.map(role => [role, previous[role].agent]))), ...preset?.agents, ...input.agents });
      selected = Object.fromEntries(EXECUTION_ROLES.map(role => {
        const matches = catalog.candidates.filter(c => c.role === role && c.agent === agents[role]);
        const candidate = matches[0];
        if (matches.length !== 1 || !candidate || candidate.unavailable !== null) {
          throw new ExecutionUnavailableError(candidate?.unavailable ?? 'not_registered', role, catalog);
        }
        return [role, candidate];
      })) as SelectedExecution;
      const contract = db.prepare('SELECT status FROM enno_contracts WHERE run_id = ?').get<{ status: string }>(input.runId);
      if (contract && ['completed', 'cancelled'].includes(contract.status)) throw new KiokukoError('CONFLICT', 'Start a new request after leaving orchestration');
    } else if (input.agents !== undefined || input.preset !== undefined) {
      throw new KiokukoError('VALIDATION_ERROR', 'Ordinary work and cancellation do not take model selections');
    }
    db.prepare('UPDATE task_execution_selections SET choice = ?, revision = revision + 1, catalog_json = ?, selected_json = ? WHERE run_id = ?')
      .run(input.choice, canonicalJson(catalog), selected === null ? null : canonicalJson(selected), input.runId);
    if (input.choice !== 'enno') {
      db.prepare("UPDATE enno_contracts SET status = 'cancelled', phase = NULL, confirmation_state = 'cancelled' WHERE run_id = ? AND status NOT IN ('completed', 'cancelled')").run(input.runId);
      if (input.choice === 'cancelled') new LedgerStore(db).updateRunStatusInTransaction(input.runId, 'cancelled');
    }
    db.prepare('INSERT INTO task_execution_receipts(run_id, operation_id, input_digest, revision) VALUES (?, ?, ?, ?)')
      .run(input.runId, operationId, digest, row.revision + 1);
    return executionView(db, input.runId)!;
  });
}

export const executionDispatchSchema = executionReadSchema.extend({
  stage: z.enum(['begin', 'complete', 'failed']), revision: z.number().int().min(1), role: z.enum(EXECUTION_ROLES),
  agent: z.string().min(1).max(256), promptDigest: z.string().regex(/^[a-f0-9]{64}$/u), callId: identity,
}).strict();
/** Reserve before model execution. An uncertain call is never replayed automatically. */
export function recordExecutionDispatch(db: SqliteDatabase, raw: z.infer<typeof executionDispatchSchema>) {
  const input = executionDispatchSchema.parse(raw);
  return withImmediateTransaction(db, () => {
    const route = readExecutionRouting(db, input);
    if (!route.active || route.choice !== 'enno' || route.revision !== input.revision
      || route.selected?.[input.role].agent !== input.agent
      || (input.role === 'gokiWorker' ? route.role !== 'gokiHead' : route.role !== input.role)) {
      throw new KiokukoError('CONFLICT', 'Execution dispatch is stale or its role does not match');
    }
    const contractRevision = db.prepare('SELECT revision FROM enno_contracts WHERE run_id = ?').get<{ revision: number }>(input.runId)?.revision;
    const promptDigest = canonicalContentHash({ prompt: input.promptDigest, contractRevision });
    const key = [input.runId, input.revision, input.role, promptDigest];
    const prior = db.prepare('SELECT call_digest, status FROM task_execution_dispatches WHERE run_id = ? AND revision = ? AND role = ? AND prompt_digest = ?')
      .get<{ call_digest: string; status: string }>(...key);
    const call = canonicalContentHash(input.callId);
    if (input.stage === 'begin') {
      if (hasExecutionFailure(db, input.runId, input.revision)) {
        throw new KiokukoError('CONFLICT', 'A selected model failed. Explicitly select another configuration, ordinary work, or cancellation.');
      }
      if (prior) throw new KiokukoError('CONFLICT', 'This role invocation was already dispatched. Reuse its completed result, or explicitly select again after a failed or interrupted call.');
      db.prepare("INSERT INTO task_execution_dispatches VALUES (?, ?, ?, ?, ?, 'started')").run(...key, call);
    } else {
      if (!prior || prior.call_digest !== call) throw new KiokukoError('CONFLICT', 'Execution dispatch receipt does not match');
      const status = input.stage === 'failed' ? 'failed' : 'completed';
      if (prior.status !== 'started') {
        if (prior.status !== status) throw new KiokukoError('CONFLICT', 'Execution dispatch is already terminal');
        return { accepted: true };
      }
      db.prepare("UPDATE task_execution_dispatches SET status = ? WHERE run_id = ? AND revision = ? AND role = ? AND prompt_digest = ? AND status = 'started'").run(status, ...key);
    }
    return { accepted: true };
  });
}
