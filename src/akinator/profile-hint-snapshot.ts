import type { SqliteDatabase } from '../db/adapter.js';
import type { JsonObject } from '../serialization/validate.js';
import { currentProfileEvidence } from './profile-memory-store.js';
import { PROFILE_TEXT_LIMIT, profileEvidenceSchema, parseProfileHintSnapshot, runtimeProbeConfig } from './memory-probe-types.js';

/** Persist references, never a second copy of candidate text in immutable revisions. */
export function snapshotProfileHints(context: JsonObject): JsonObject {
  const copy = structuredClone(context);
  const intake = copy.intake;
  if (!intake || Array.isArray(intake) || typeof intake !== 'object') return copy;
  const hints = intake.memoryHints;
  if (!hints) return copy;
  const validated = parseProfileHintSnapshot(hints);
  intake.memoryHints = { ...validated, candidates: validated.candidates.map(({ value: _value, ...reference }) => reference) };
  return copy;
}

/** Hydration is read-only and rechecks the exact source, including at compaction/replay. */
export function hydrateProfileHints(database: SqliteDatabase, context: JsonObject, runId: string): JsonObject {
  const copy = snapshotProfileHints(context);
  const intake = copy.intake;
  if (!intake || Array.isArray(intake) || typeof intake !== 'object' || !intake.memoryHints) return copy;
  const mode = runtimeProbeConfig().mode;
  if (mode === 'off' || mode === 'shadow') { delete intake.memoryHints; return copy; }
  const hints = intake.memoryHints;
  if (Array.isArray(hints) || typeof hints !== 'object' || !Array.isArray(hints.candidates)) {
    delete intake.memoryHints;
    return copy;
  }
  const workspace = database.prepare('SELECT workspace FROM ledger_runs WHERE run_id = ?').get<{ workspace: string }>(runId)?.workspace;
  const hydrated = [];
  for (const candidate of hints.candidates) {
    if (!candidate || Array.isArray(candidate) || typeof candidate !== 'object') continue;
    const parsed = profileEvidenceSchema.safeParse(candidate.source);
    if (!parsed.success || parsed.data.workspace !== workspace) continue;
    const field = candidate.field;
    if (field !== 'taskType' && field !== 'target' && field !== 'expected' && field !== 'constraints') continue;
    const document = currentProfileEvidence(database, parsed.data);
    const value = document?.session.profile[field];
    if (value && value.length <= PROFILE_TEXT_LIMIT) hydrated.push({ ...candidate, value });
  }
  if (hydrated.length !== hints.candidates.length) hints.status = 'incomplete';
  hints.candidates = hydrated;
  return copy;
}
