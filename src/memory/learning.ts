import { createApprovedReplayMemoryStore } from './replay-store.js';
import { approvedReplayContext } from './replay-context.js';
import * as z from 'zod/v4';
import path from 'node:path';
import type { SqliteDatabase, SqliteRow } from '../db/adapter.js';
import { KiokukoError } from '../errors.js';
import { canonicalContentHash, canonicalJson } from '../serialization/validate.js';
import { containsPrivateLearningData } from './learning-safety.js';
import { resolveProjectWorkspaceReadOnly, GLOBAL_WORKSPACE } from './workspaces.js';
import { recordEntryInTransaction, readEntry } from './entries.js';
import { DEFAULT_CONTEXT_CHARACTERS } from './context-budget.js';
import { attachRelationDelivery, configuredRelationDeliveryOptions, legacyRelationDelivery } from './relation-delivery.js';

const id = z.string().min(1).max(256).regex(/^[\w.:/-]+$/u);
const text = z.string().trim().max(2048).refine(value => !/[\p{Cc}\p{Cf}]/u.test(value.replaceAll('\n', '')));
const cwd = z.string().min(1).max(4096).refine(value => path.isAbsolute(value) && !/[\p{Cc}\p{Cf}]/u.test(value));
const result = z.enum(['passed', 'failed', 'unknown']);
export const memoryObserveSchema = z.object({
  cwd, eventId: id, sessionId: id,
  kind: z.enum(['compaction', 'completion', 'model_switch', 'complaint', 'praise']),
  summary: text.default(''), tags: z.array(z.string().trim().min(1).max(64).regex(/^[^\p{Cc}\p{Cf}]+$/u)).max(20).default([]),
  outcome: result.default('unknown'), verification: result.default('unknown'),
  actions: z.array(z.object({ kind: z.enum(['inspect', 'edit', 'build', 'test', 'recover', 'explain', 'other']), outcome: result.default('unknown'), summary: z.string().trim().max(512).default('') }).strict()).max(20).default([]),
  source: z.object({ producer: z.enum(['codex', 'agenticreplay', 'kiokuko-ai', 'kiokuko-dsh']), runId: id.optional(), eventIds: z.array(id).max(40).default([]),
    revision: z.number().int().nonnegative().default(0), tombstone: z.boolean().default(false),
  }).strict(),
  issue: text.optional(), prevention: text.optional(), fromModel: z.string().max(128).optional(), toModel: z.string().max(128).optional(),
}).strict().refine(value => value.source.tombstone || value.summary.length > 0, 'A live observation needs a public summary');
export const memoryContextSchema = z.object({ cwd, query: z.string().max(500).default(''),
  tags: z.array(z.string().min(1).max(64)).max(20).default([]), sessionId: id.optional(), limit: z.number().int().min(1).max(50).default(10),
  maxContextChars: z.number().int().min(1).max(100_000).default(DEFAULT_CONTEXT_CHARACTERS),
}).strict();
export const memoryImproveSchema = z.object({ cwd, limit: z.number().int().min(1).max(200).default(100) }).strict();
type Observation = z.infer<typeof memoryObserveSchema>;
interface ObservationRow extends SqliteRow { workspace: string; producer: string; event_id: string; source_revision: number; session_id: string; digest: string; observation_json: string; entry_id: string | null; created_at: string }

export interface LearningReceipt { accepted: boolean; recorded: boolean; workMayContinue: true; warnings: string[]; diagnostics: string[]; duplicate?: boolean; sourceRevision?: number; entryId?: string; sourceEventId?: string }
export function learningFailure(error: unknown): LearningReceipt {
  const code = error instanceof KiokukoError ? error.code : 'DATABASE_ERROR';
  return { accepted: false, recorded: false, workMayContinue: true, warnings: [code], diagnostics: [code] };
}

function validate<T>(schema: z.ZodType<T>, raw: unknown): T {
  const parsed = schema.safeParse(raw);
  if (!parsed.success) throw new KiokukoError('VALIDATION_ERROR', 'Invalid public learning input');
  if (containsPrivateLearningData(parsed.data)) throw new KiokukoError('SECURITY_REJECTION', 'Learning input contains credentials');
  if (Buffer.byteLength(canonicalJson(parsed.data)) > 16384) throw new KiokukoError('VALIDATION_ERROR', 'Learning input exceeds the byte bound');
  return parsed.data;
}

const CURRENT_OBSERVATIONS = `SELECT o.* FROM learning_observations o WHERE o.workspace=? AND o.tombstone=0
 AND NOT EXISTS(SELECT 1 FROM learning_observations newer WHERE newer.workspace=o.workspace
 AND newer.producer=o.producer AND newer.event_id=o.event_id AND newer.source_revision>o.source_revision)`;

function observationFromRow(row: ObservationRow): Observation {
  const input = validate(memoryObserveSchema, JSON.parse(row.observation_json));
  if (canonicalContentHash(input) !== row.digest || input.eventId !== row.event_id
    || input.sessionId !== row.session_id || input.source.producer !== row.producer || input.source.revision !== row.source_revision) {
    throw new KiokukoError('INTEGRITY_ERROR', 'Stored learning evidence was changed');
  }
  return input;
}

function retireEntry(database: SqliteDatabase, entryId: string, replacementId?: string): void {
  const row = database.prepare('SELECT workspace,status FROM entries WHERE id=?').get<{ workspace: string; status: string }>(entryId);
  if (!row || row.status === 'superseded') return;
  const entry = readEntry(database, { workspace: row.workspace, entryId });
  const replacement = replacementId ?? recordEntryInTransaction(database, { workspace: row.workspace, kind: 'reference',
    title: 'Withdrawn learning source', body: 'The source of this learning candidate was revised or withdrawn. Its previous advice is no longer current.',
    scope: entry.scope, confidence: 0, tags: ['learning-withdrawn'],
    provenance: { type: 'learning_retraction', reference: canonicalContentHash(entryId) }, createdBy: 'kiokuko-ai-learning' }).id;
  database.prepare("UPDATE entries SET status='superseded',superseded_by=?,updated_at=? WHERE id=? AND workspace=?")
    .run(replacement, new Date().toISOString(), entryId, row.workspace);
}

/** The existing confirmed purge also withdraws its observation; it cannot resurrect through recall. */
export function withdrawPurgedLearningEntry(database: SqliteDatabase, workspace: string, entryId: string, now: string): void {
  if (!database.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='learning_observations'").get()) return;
  for (const row of database.prepare(`${CURRENT_OBSERVATIONS} AND o.entry_id=?`).all<ObservationRow>(workspace, entryId)) {
    const prior = observationFromRow(row);
    const tombstone = { ...prior, source: { ...prior.source, revision: prior.source.revision + 1, tombstone: true } };
    database.prepare('INSERT INTO learning_observations VALUES(?,?,?,?,?,?,?,?,?,?)').run(workspace, row.producer, row.event_id,
      tombstone.source.revision, row.session_id, canonicalContentHash(tombstone), canonicalJson(tombstone), 1, null, now);
    for (const derived of database.prepare('SELECT entry_id FROM learning_principles WHERE entry_id IS NOT NULL AND EXISTS(SELECT 1 FROM json_each(source_json) WHERE value=?)')
      .all<{ entry_id: string }>(row.digest)) retireEntry(database, derived.entry_id);
  }
}

/** Legacy tool compatibility: automatic events are not consent to create memory. */
export async function observeMemory(_database: SqliteDatabase, _raw: unknown): Promise<LearningReceipt> {
  return { accepted: false, recorded: false, workMayContinue: true,
    warnings: ['post_task_review_required'], diagnostics: ['post_task_review_required'] };
}

/** Bounded keyword/tag recall is repository scoped; handoff is same-session only. */
export async function memoryContext(database: SqliteDatabase, raw: unknown) {
  try {
    const input = validate(memoryContextSchema, raw);
    const project = await resolveProjectWorkspaceReadOnly(database, input.cwd);
    if (!project) throw new KiokukoError('NOT_FOUND', 'A project is required for memory context');
    const tokens = (input.query.toLowerCase().match(/[\p{L}\p{N}_-]{2,64}/gu) ?? []).slice(0, 12);
    const requestedTags = input.tags.map(tag => tag.toLowerCase());
    // Apply selectors before the result bound so older cautions remain searchable.
    const clauses = [
      ...(tokens.length ? [`(${tokens.map(() => "instr(lower(json_extract(o.observation_json,'$.summary') || coalesce(json_extract(o.observation_json,'$.issue'),'') || coalesce(json_extract(o.observation_json,'$.prevention'),'') || json_extract(o.observation_json,'$.tags')),?)>0").join(' OR ')})`] : []),
      ...requestedTags.map(() => "(EXISTS(SELECT 1 FROM json_each(json_extract(o.observation_json,'$.tags')) tag WHERE lower(tag.value)=?) OR json_extract(o.observation_json,'$.kind')=?)"),
    ];
    const rows = database.prepare(`${CURRENT_OBSERVATIONS} AND json_extract(o.observation_json,'$.kind') NOT IN ('model_switch','compaction')${clauses.length ? ' AND ' + clauses.join(' AND ') : ''} ORDER BY o.rowid DESC LIMIT 200`)
      .all<ObservationRow>(project.workspace, ...tokens, ...requestedTags.flatMap(tag => [tag, tag]));
    const selected = rows.filter(row => {
      const value = observationFromRow(row);
      return requestedTags.every(tag => value.tags.map(value => value.toLowerCase()).includes(tag) || value.kind === tag)
        && (!tokens.length || tokens.some(token => `${value.summary} ${value.issue ?? ''} ${value.prevention ?? ''} ${value.tags.join(' ')}`.toLowerCase().includes(token)));
    }).sort((a, b) => {
      const left = observationFromRow(a), right = observationFromRow(b);
      return Number(right.kind === 'complaint') - Number(left.kind === 'complaint');
    });
    let remaining = input.maxContextChars;
    const items = selected.slice(0, input.limit).flatMap(row => {
      const value = observationFromRow(row);
      if (!row.entry_id) return [];
      const entry = readEntry(database, { workspace: project.workspace, entryId: row.entry_id });
      const item = { entryId: row.entry_id, workspace: project.workspace, revision: entry.revision, kind: value.kind, summary: value.summary.slice(0, 800), tags: entry.tags,
        ...(value.issue ? { issue: value.issue.slice(0, 400) } : {}), ...(value.prevention ? { prevention: value.prevention.slice(0, 400) } : {}),
        confidence: value.verification === 'passed' && value.actions.some(action => action.kind === 'test' && action.outcome === 'passed') ? 0.65 : 0.3, verification: value.verification,
        verificationProvenance: value.verification === 'unknown' ? 'unknown' : 'declared', scope: 'project', sourceEventIds: [row.digest],
        actions: value.actions.slice(0, 6).map(action => ({ ...action, summary: action.summary.slice(0, 300) })),
        source: { ...value.source, eventIds: value.source.eventIds.slice(0, 6), eventId: value.eventId }, untrusted: true };
      const size = Array.from(JSON.stringify(item)).length;
      if (size > remaining) return [];
      remaining -= size;
      return [item];
    });
    const handoffRow = input.sessionId === undefined ? undefined : database.prepare(`${CURRENT_OBSERVATIONS} AND o.session_id=? AND o.created_at>?
      AND json_extract(o.observation_json,'$.kind') IN ('completion','compaction','model_switch')
      AND NOT EXISTS(SELECT 1 FROM json_each(json_extract(o.observation_json,'$.tags')) tag WHERE tag.value='lifecycle-signal') ORDER BY o.rowid DESC LIMIT 1`)
      .get<ObservationRow>(project.workspace, input.sessionId, new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString());
    const handoff = handoffRow ? (() => {
      const value = observationFromRow(handoffRow);
      return { sessionId: value.sessionId, summary: value.summary.slice(0, 800), sourceEventId: value.eventId,
        sourceRevision: value.source.revision, verification: value.verification, tags: value.tags, sourceEventIds: [handoffRow.digest],
        updatedAt: handoffRow.created_at, expiresAt: new Date(Date.parse(handoffRow.created_at) + 24 * 60 * 60 * 1000).toISOString(), untrusted: true };
    })() : null;
    const derivedEntries = (workspace: string, maximum: number) => database.prepare('SELECT entry_id FROM learning_principles WHERE workspace=? AND entry_id IS NOT NULL ORDER BY rowid DESC LIMIT 50')
      .all<{ entry_id: string }>(workspace).flatMap(row => {
        const entry = readEntry(database, { workspace, entryId: row.entry_id });
        if (entry.status === 'superseded' || requestedTags.some(tag => !entry.tags.includes(tag))
          || (tokens.length && !tokens.some(token => `${entry.title} ${entry.body} ${entry.tags.join(' ')}`.toLowerCase().includes(token)))) return [];
        return [{ entryId: entry.id, workspace, revision: entry.revision, kind: entry.kind, title: entry.title, summary: entry.body.slice(0, 800),
          tags: entry.tags, confidence: entry.confidence, verification: 'unknown', verificationProvenance: 'unknown',
          scope: workspace === GLOBAL_WORKSPACE ? 'global' : 'project', sourceEventIds: entry.provenance.evidenceIds ?? [], untrusted: true }];
      }).slice(0, maximum);
    const routines = derivedEntries(project.workspace, 3);
    const principles = database.prepare("SELECT entry_id FROM learning_principles WHERE workspace='global' AND entry_id IS NOT NULL ORDER BY rowid DESC LIMIT 5")
      .all<{ entry_id: string }>().flatMap(row => {
        const entry = readEntry(database, { workspace: GLOBAL_WORKSPACE, entryId: row.entry_id });
        return entry.status === 'superseded' || requestedTags.some(tag => !entry.tags.includes(tag))
          || (tokens.length && !tokens.some(token => `${entry.title} ${entry.body}`.toLowerCase().includes(token))) ? [] : [{ entryId: entry.id, workspace: GLOBAL_WORKSPACE, revision: entry.revision, kind: entry.kind, title: entry.title, summary: entry.body.slice(0, 300),
          tags: entry.tags, confidence: entry.confidence, verification: 'unknown', verificationProvenance: 'unknown', scope: 'global', sourceEventIds: entry.provenance.evidenceIds ?? [], source: entry.provenance.reference, untrusted: true }];
      }).slice(0, 2);
    const approved = createApprovedReplayMemoryStore(database, project.workspace)
      .query(input.query, input.tags, input.limit).map(proposal => {
        const preview = approvedReplayContext(proposal);
        const mapped = database.prepare('SELECT r.entry_id, r.entry_revision FROM replay_memories m JOIN replay_memory_entries r ON r.memory_key=m.approval_key WHERE m.workspace=? AND m.proposal_id=? AND m.revision=? ORDER BY m.created_at DESC LIMIT 1')
          .get<{ entry_id: string; entry_revision: number }>(project.workspace, proposal.proposalId, proposal.revision);
        return mapped ? { ...preview, proposalId: preview.entryId, proposalRevision: preview.revision,
          entryId: mapped.entry_id, revision: mapped.entry_revision, workspace: project.workspace } : preview;
      });
    const candidates = [...approved, ...items, ...routines, ...principles];
    const entries = candidates.slice(0, input.limit);
    const body = () => {
      const ids = new Set(entries.map(entry => entry.entryId));
      return { entries, items: items.filter(entry => ids.has(entry.entryId)), routines: routines.filter(entry => ids.has(entry.entryId)),
        principles: principles.filter(entry => ids.has(entry.entryId)), handoff };
    };
    let budgetOmitted = false;
    while (Array.from(JSON.stringify(body())).length > input.maxContextChars) {
      budgetOmitted = true;
      if (entries.length) entries.pop();
      else throw new KiokukoError('VALIDATION_ERROR', 'Learning context budget cannot fit its explicit body envelope');
    }
    const selectionOmissions = [...(budgetOmitted ? ['body_budget' as const] : []),
      ...(candidates.length >= input.limit ? ['item_limit' as const] : [])];
    const known = entries.every(entry => database.prepare('SELECT 1 present FROM entries WHERE id=?').get(entry.entryId));
    const relationDelivery = known ? attachRelationDelivery(database, { items: entries }, { selectionOmissions }).relationDelivery
      : legacyRelationDelivery(configuredRelationDeliveryOptions({ selectionOmissions }));
    return { available: true, accepted: true, recorded: false, workMayContinue: true as const, repositoryId: project.repositoryId,
      ...body(), relationDelivery, warnings: [], diagnostics: [], truncated: budgetOmitted || selected.length > items.length };
  } catch (error) { return { ...learningFailure(error), available: false, entries: [], items: [], handoff: null }; }
}

/** New derived principles require the same native human review as other memories. */
export async function improveMemory(_database: SqliteDatabase, _raw: unknown) {
  return { accepted: false, recorded: false, workMayContinue: true,
    warnings: ['post_task_review_required'], diagnostics: ['post_task_review_required'] };
}
