import * as z from 'zod/v4';
import type { SqliteDatabase } from '../db/adapter.js';
import { KiokukoError } from '../errors.js';
import { canonicalContentHash, type JsonObject } from '../serialization/validate.js';
import { assertCapabilityCatalogBinding, capabilityCatalogDigest } from '../akinator/capability-binding.js';
import { checkpointPathSchema, checkpointSignalSchema } from '../ledger/checkpoint-contract.js';
import { findSecretInValue } from '../memory/secrets.js';
import { readContextRunRetrievalState } from './run-state.js';
import { queryScopedContextTransaction, type ScopedContextResult } from './scoped-broker.js';
import { recordTaskContextRevisionInTransaction } from './revisions.js';
import { memoryApplicationProject, replayMemoryOperation, rememberMemoryOperation } from './memory-application.js';

export const contextRefreshSchema = z.object({
  cwd: z.string().min(1), runId: z.string().min(1).max(256), requestId: z.string().min(1).max(256),
  expectedContextRevision: z.number().int().positive(), capabilities: z.array(z.unknown()).optional(),
  changedPaths: z.array(checkpointPathSchema).max(200).default([]),
  errorSignatures: z.array(checkpointSignalSchema).max(200).default([]),
}).strict().refine(input => input.changedPaths.length + input.errorSignatures.length > 0, 'Provide new paths or error signatures');
interface RefreshResult { runId: string; contextRevision: number; context: ScopedContextResult }

/** Re-query the bound project/run; never open another task or alter its capabilities. */
export async function refreshTaskContext(database: SqliteDatabase, raw: unknown): Promise<RefreshResult> {
  const parsed = contextRefreshSchema.safeParse(raw);
  if (!parsed.success) throw new KiokukoError('VALIDATION_ERROR', 'Invalid task context refresh');
  const input = parsed.data;
  if (findSecretInValue({ changedPaths: input.changedPaths, errorSignatures: input.errorSignatures })) throw new KiokukoError('SECURITY_REJECTION', 'Refresh signals contain secret-shaped data');
  const project = await memoryApplicationProject(database, input.cwd, input.runId);
  const state = readContextRunRetrievalState(database, input.runId);
  assertCapabilityCatalogBinding(state.run.metadata, input.capabilities);
  const digest = canonicalContentHash({ kind: 'refresh', ...input, capabilities: capabilityCatalogDigest(input.capabilities) });
  const old = replayMemoryOperation<RefreshResult>(database, input, digest);
  if (old) return old;
  const assertCurrent = () => {
    const revision = database.prepare('SELECT MAX(context_revision) AS revision FROM task_context_revisions WHERE run_id = ?')
      .get<{ revision: number }>(input.runId)?.revision;
    if (revision !== input.expectedContextRevision) throw new KiokukoError('CONFLICT', 'Task context revision changed');
  };
  assertCurrent();
  const binding = state.run.metadata.kiokukoOpenCodeTaskContextBinding as JsonObject | undefined;
  if (typeof binding?.maxContextChars !== 'number') throw new KiokukoError('INTEGRITY_ERROR', 'Task context budget binding is missing');
  const budget = binding.maxContextChars;
  let result: RefreshResult | undefined;
  try {
    await queryScopedContextTransaction(database, {
      project, task: state.run.title ?? '', taskProfile: state.profile, recommendedTags: state.recommendedTags,
      runId: input.runId, changedPaths: input.changedPaths, errorSignatures: input.errorSignatures, characterBudget: budget,
    }, digest, assertCurrent, context => {
      const revision = recordTaskContextRevisionInTransaction(database, {
        runId: input.runId, context: { kind: 'memory_refresh', context: context as unknown as JsonObject,
          refreshRequestDigest: digest },
      });
      result = { runId: input.runId, contextRevision: revision.contextRevision, context };
      rememberMemoryOperation(database, input, digest, result);
    });
  } catch (error) {
    // A concurrent identical request may have committed while retrieval awaited.
    if (error instanceof KiokukoError && error.code === 'CONFLICT') {
      const replay = replayMemoryOperation<RefreshResult>(database, input, digest);
      if (replay) return replay;
    }
    throw error;
  }
  if (!result) throw new KiokukoError('INTEGRITY_ERROR', 'Refresh result was not persisted');
  return result;
}
