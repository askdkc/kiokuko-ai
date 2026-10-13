import * as z from 'zod/v4';
import path from 'node:path';
import { realpath } from 'node:fs/promises';
import type { SqliteDatabase, SqliteRow } from '../db/adapter.js';
import { withImmediateTransaction } from '../db/transaction.js';
import { KiokukoError } from '../errors.js';
import { canonicalContentHash, canonicalJson } from '../serialization/validate.js';
import { containsPrivateLearningData } from './learning-safety.js';
import { resolveProjectWorkspace, resolveProjectWorkspaceReadOnly, ensureGlobalWorkspace, GLOBAL_WORKSPACE } from './workspaces.js';
import { recordEntryInTransaction, updateCandidateEntryInTransaction, readEntry, type RecordEntryInput } from './entries.js';
import { buildStructuredScope } from './structured-memory.js';
import { enqueueOrchestrationJob } from '../orchestration/jobs.js';
import { readTraceAdvisory } from '../trace/advisory.js';
import { readRegularFile } from '../agent-file/atomic-write.js';
import { agenticReplayRunIdFromDirectory } from '../trace/agentic-trace.js';

async function activeRecordedTrace(database: SqliteDatabase, root: string) {
  const configured = process.env.AGENTICREPLAY_RUN_DIR;
  if (!configured || !path.isAbsolute(configured)) return undefined;
  try {
    const directory = await realpath(configured);
    const relative = path.relative(root, directory);
    if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return undefined;
    const manifest = await readRegularFile(path.join(directory, 'manifest.json'), { containmentRoot: root, maxBytes: 8192 });
    if (!manifest) return undefined;
    const value = JSON.parse(manifest.content) as Record<string, unknown>;
    if (typeof value.run_id !== 'string' || !/^run_[0-9a-f]{6,32}$/u.test(value.run_id)) return undefined;
    if (agenticReplayRunIdFromDirectory(path.basename(directory)) !== value.run_id) return undefined;
    const runs = path.dirname(directory);
    const context = readTraceAdvisory(database, root, path.dirname(runs), value.run_id, runs).context;
    return context?.sourceAvailable === false ? undefined : context;
  } catch { return undefined; }
}

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

function currentRows(database: SqliteDatabase, workspace: string, limit: number): ObservationRow[] {
  return database.prepare(`${CURRENT_OBSERVATIONS} ORDER BY o.rowid DESC LIMIT ?`).all<ObservationRow>(workspace, limit);
}

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

/** Same event/revision replays exactly; a changed identity never overwrites evidence. */
export async function observeMemory(database: SqliteDatabase, raw: unknown): Promise<LearningReceipt> {
  try {
    const input = validate(memoryObserveSchema, raw);
    const project = await resolveProjectWorkspace(database, input.cwd);
    if (!project) throw new KiokukoError('NOT_FOUND', 'A project is required for learning');
    const trace = input.source.producer === 'agenticreplay' && input.source.runId !== undefined
      ? readTraceAdvisory(database, project.repositoryRoot, input.cwd, input.source.runId).context
      : input.kind === 'praise' ? await activeRecordedTrace(database, project.repositoryRoot) : undefined;
    if (input.source.producer === 'agenticreplay' && input.source.runId !== undefined && (!trace || trace.sourceAvailable === false)) {
      throw new KiokukoError('NOT_FOUND', 'The exact AgenticReplay source was not available in this repository');
    }
    if (trace && containsPrivateLearningData(trace.context.summary)) {
      throw new KiokukoError('SECURITY_REJECTION', 'AgenticReplay learning source contains credentials');
    }
    const stored = { ...input, cwd: project.repositoryRoot };
    const digest = canonicalContentHash(stored);
    return withImmediateTransaction(database, () => {
      const previous = database.prepare('SELECT * FROM learning_observations WHERE workspace=? AND producer=? AND event_id=? ORDER BY source_revision DESC LIMIT 1')
        .get<ObservationRow>(project.workspace, input.source.producer, input.eventId);
      if (previous && previous.source_revision >= input.source.revision) {
        if (previous.source_revision === input.source.revision && previous.digest === digest) return { accepted: true, recorded: true, duplicate: true, sourceRevision: input.source.revision, sourceEventId: digest, workMayContinue: true, warnings: [], diagnostics: [] };
        throw new KiokukoError('CONFLICT', 'Learning source revision is stale or changed');
      }
      if (previous && (previous.session_id !== input.sessionId || observationFromRow(previous).source.runId !== input.source.runId)) throw new KiokukoError('CONFLICT', 'Learning source identity changed');
      const now = new Date().toISOString();
      let entryId: string | null = null;
      const verified = input.verification === 'passed' && input.actions.some(action => action.kind === 'test' && action.outcome === 'passed');
      if (!input.source.tombstone && input.kind !== 'model_switch' && input.kind !== 'compaction') {
        const caution = input.kind === 'complaint';
        const proposal: RecordEntryInput = {
          workspace: project.workspace, kind: 'lesson', status: 'candidate', trustLevel: 'untrusted',
          title: `${caution ? 'Caution' : input.kind === 'praise' ? 'Procedure candidate' : 'Public work summary'}: ${input.summary.slice(0, 100).replaceAll('\n', ' ')}`,
          body: [input.summary, ...(caution ? [`Reported failure: ${input.issue ?? input.summary}`, `Prevention: ${input.prevention ?? 'Reproduce this report and verify a regression at the ordinary entry point.'}`] : []),
            ...input.actions.map(action => `${action.kind}: ${action.outcome}; ${action.summary}`),
            ...(trace ? [`AgenticReplay recorded action/result summary: ${canonicalJson(trace.context.summary)}; source ${trace.traceRunId}; source digest: ${trace.digest}.`] : []),
            `Verification: ${verified ? 'producer-reported passed check' : 'unknown or incomplete'}; source: ${input.source.producer}/${input.eventId}@${input.source.revision}.`,
          ].join('\n'),
          confidence: verified ? 0.65 : caution ? 0.5 : 0.3,
          tags: [...new Set(['learning-observation', input.kind, ...input.tags.map(tag => tag.toLowerCase())])],
          scope: buildStructuredScope({ visibility: 'project', retrievalScope: 'project-only', repositoryId: project.repositoryId, memoryClass: caution ? 'gotcha' : 'workflow' }),
          provenance: { type: 'learning_observation', reference: digest, sourceRepositoryId: project.repositoryId, sourceWorkspace: project.workspace,
            clientKind: 'opencode', timestamp: now }, createdBy: 'kiokuko-ai-learning',
        };
        const priorEntry = previous?.entry_id ? readEntry(database, { workspace: project.workspace, entryId: previous.entry_id }) : undefined;
        const entry = priorEntry?.status === 'candidate'
          ? updateCandidateEntryInTransaction(database, { ...proposal, entryId: priorEntry.id, expectedRevision: priorEntry.revision })
          : recordEntryInTransaction(database, proposal);
        if (priorEntry?.status === 'candidate') database.prepare('UPDATE entries SET confidence=? WHERE id=?').run(proposal.confidence!, entry.id);
        entryId = entry.id;
      }
      if (input.source.tombstone && previous?.entry_id) {
        const prior = readEntry(database, { workspace: project.workspace, entryId: previous.entry_id });
        if (prior.status === 'candidate') {
          const withdrawn = updateCandidateEntryInTransaction(database, { workspace: project.workspace, entryId: prior.id, expectedRevision: prior.revision,
            kind: 'reference', title: 'Withdrawn learning source', body: 'This source evaluation was withdrawn; its previous advice is not current.',
            scope: prior.scope, provenance: { type: 'learning_retraction', reference: digest }, tags: ['learning-withdrawn'], createdBy: 'kiokuko-ai-learning' });
          database.prepare('UPDATE entries SET confidence=0 WHERE id=?').run(withdrawn.id);
          entryId = withdrawn.id;
        }
      }
      if (previous?.entry_id && previous.entry_id !== entryId) retireEntry(database, previous.entry_id, entryId ?? undefined);
      if (previous) {
        for (const derived of database.prepare('SELECT entry_id FROM learning_principles WHERE entry_id IS NOT NULL AND EXISTS(SELECT 1 FROM json_each(source_json) WHERE value=?)')
          .all<{ entry_id: string }>(previous.digest)) retireEntry(database, derived.entry_id);
      }
      if (input.kind === 'complaint' && !input.source.tombstone) {
        for (const related of database.prepare(`${CURRENT_OBSERVATIONS} AND o.session_id=?`).all<ObservationRow>(project.workspace, input.sessionId)) {
          for (const derived of database.prepare('SELECT entry_id FROM learning_principles WHERE entry_id IS NOT NULL AND EXISTS(SELECT 1 FROM json_each(source_json) WHERE value=?)')
            .all<{ entry_id: string }>(related.digest)) retireEntry(database, derived.entry_id);
        }
      }
      database.prepare('INSERT INTO learning_observations VALUES(?,?,?,?,?,?,?,?,?,?)').run(project.workspace, input.source.producer, input.eventId,
        input.source.revision, input.sessionId, digest, canonicalJson(stored), input.source.tombstone ? 1 : 0, entryId, now);
      // Reuse the existing bounded worker; Global candidates are not promotions.
      enqueueOrchestrationJob(database, { kind: 'memory_promotion', payload: { source: 'learning', cwd: project.repositoryRoot,
        sourceDigest: digest, bucket: Math.floor(Date.now() / 300_000) } });
      return { accepted: true, recorded: true, sourceRevision: input.source.revision, sourceEventId: digest,
        ...(entryId === null ? {} : { entryId }), workMayContinue: true, warnings: verified ? [] : ['verification_unconfirmed'], diagnostics: verified ? [] : ['verification_unconfirmed'] };
    });
  } catch (error) { return learningFailure(error); }
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
    let remaining = 3500;
    const items = selected.slice(0, input.limit).flatMap(row => {
      const value = observationFromRow(row);
      if (!row.entry_id) return [];
      const entry = readEntry(database, { workspace: project.workspace, entryId: row.entry_id });
      const item = { entryId: row.entry_id, revision: entry.revision, kind: value.kind, summary: value.summary.slice(0, 800), tags: entry.tags,
        ...(value.issue ? { issue: value.issue.slice(0, 400) } : {}), ...(value.prevention ? { prevention: value.prevention.slice(0, 400) } : {}),
        confidence: value.verification === 'passed' && value.actions.some(action => action.kind === 'test' && action.outcome === 'passed') ? 0.65 : 0.3, verification: value.verification,
        verificationProvenance: value.verification === 'unknown' ? 'unknown' : 'declared', scope: 'project', sourceEventIds: [row.digest],
        actions: value.actions.slice(0, 6).map(action => ({ ...action, summary: action.summary.slice(0, 300) })),
        source: { ...value.source, eventIds: value.source.eventIds.slice(0, 6), eventId: value.eventId }, untrusted: true };
      const size = JSON.stringify(item).length;
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
        return [{ entryId: entry.id, revision: entry.revision, kind: entry.kind, title: entry.title, summary: entry.body.slice(0, 800),
          tags: entry.tags, confidence: entry.confidence, verification: 'unknown', verificationProvenance: 'unknown',
          scope: workspace === GLOBAL_WORKSPACE ? 'global' : 'project', sourceEventIds: entry.provenance.evidenceIds ?? [], untrusted: true }];
      }).slice(0, maximum);
    const routines = derivedEntries(project.workspace, 3);
    const principles = database.prepare("SELECT entry_id FROM learning_principles WHERE workspace='global' AND entry_id IS NOT NULL ORDER BY rowid DESC LIMIT 5")
      .all<{ entry_id: string }>().flatMap(row => {
        const entry = readEntry(database, { workspace: GLOBAL_WORKSPACE, entryId: row.entry_id });
        return entry.status === 'superseded' || requestedTags.some(tag => !entry.tags.includes(tag))
          || (tokens.length && !tokens.some(token => `${entry.title} ${entry.body}`.toLowerCase().includes(token))) ? [] : [{ entryId: entry.id, revision: entry.revision, kind: entry.kind, title: entry.title, summary: entry.body.slice(0, 300),
          tags: entry.tags, confidence: entry.confidence, verification: 'unknown', verificationProvenance: 'unknown', scope: 'global', sourceEventIds: entry.provenance.evidenceIds ?? [], source: entry.provenance.reference, untrusted: true }];
      }).slice(0, 2);
    return { available: true, accepted: true, recorded: false, workMayContinue: true as const, repositoryId: project.repositoryId, entries: [...items, ...routines, ...principles].slice(0, input.limit), items, routines, principles, handoff, warnings: [], diagnostics: [], truncated: selected.length > items.length };
  } catch (error) { return { ...learningFailure(error), available: false, entries: [], items: [], handoff: null }; }
}

/** Extract fixed portable principles, never copy project text, personal data or log bodies into Global. */
export async function improveMemory(database: SqliteDatabase, raw: unknown) {
  try {
    const input = validate(memoryImproveSchema, raw);
    const project = await resolveProjectWorkspaceReadOnly(database, input.cwd);
    if (!project) throw new KiokukoError('NOT_FOUND', 'A project is required for memory improvement');
    return withImmediateTransaction(database, () => {
      const rows = currentRows(database, project.workspace, input.limit);
      const groups = new Map<string, ObservationRow[]>();
      for (const row of rows) {
        const value = observationFromRow(row);
        if (value.kind !== 'completion' || value.outcome !== 'passed' || !value.actions.length) continue;
        const fingerprint = canonicalContentHash(value.actions.map(action => action.kind));
        const group = groups.get(fingerprint) ?? []; group.push(row); groups.set(fingerprint, group);
      }
      let routines = 0, principles = 0;
      const save = (workspace: string, sources: ObservationRow[], title: string, body: string, confidence: number, tags: string[]) => {
        const references = sources.map(row => row.digest).sort();
        const digest = canonicalContentHash({ title, references });
        if (database.prepare('SELECT 1 FROM learning_principles WHERE workspace=? AND digest=?').get(workspace, digest)) return;
        const entry = recordEntryInTransaction(database, { workspace, kind: 'lesson', status: 'candidate', trustLevel: 'untrusted', title, body,
          tags, confidence, scope: buildStructuredScope({ visibility: workspace === GLOBAL_WORKSPACE ? 'global' : 'project',
            retrievalScope: workspace === GLOBAL_WORKSPACE ? 'global' : 'project-only', ...(workspace === GLOBAL_WORKSPACE ? { portableReason: 'A fixed generic principle with opaque evidence links; no source text is exported.' } : { repositoryId: project.repositoryId }), memoryClass: 'workflow' }),
          provenance: { type: 'learning_principle', reference: digest, evidenceIds: references }, createdBy: 'kiokuko-ai-learning' });
        database.prepare('INSERT INTO learning_principles VALUES(?,?,?,?)').run(workspace, digest, entry.id, canonicalJson(references));
        if (workspace === GLOBAL_WORKSPACE) principles++; else routines++;
      };
      ensureGlobalWorkspace(database);
      for (const group of groups.values()) {
        if (new Set(group.map(row => row.session_id)).size < 2) continue;
        const source = observationFromRow(group[0]!);
        const sessions = new Set(group.map(row => row.session_id));
        if (rows.some(row => sessions.has(row.session_id) && observationFromRow(row).kind === 'complaint')) continue;
        const verified = group.every(row => {
          const value = observationFromRow(row);
          return value.verification === 'passed' && value.actions.some(action => action.kind === 'test' && action.outcome === 'passed');
        });
        save(project.workspace, group, 'Repeated procedure candidate', `Observed action sequence: ${source.actions.map(action => action.kind).join(' → ')}.\nIndependent sessions: ${new Set(group.map(row => row.session_id)).size}.\nVerification: ${verified ? 'producer-reported checks passed' : 'unknown; silence is not success evidence'}.\nSources: ${group.map(row => row.digest).join(', ')}.`, verified ? 0.6 : 0.3, ['learning-routine', 'candidate']);
        save(GLOBAL_WORKSPACE, group, 'Treat repeated completion as a candidate',
          'Repeated actions and completion signals suggest a possible routine. Absence of complaints is not verification. Keep source links and actual check results, and retest the ordinary entry point before reuse.', verified ? 0.6 : 0.3, ['learning-principle', 'verification']);
      }
      ensureGlobalWorkspace(database);
      const complaints = rows.filter(row => observationFromRow(row).kind === 'complaint');
      if (complaints.length) save(GLOBAL_WORKSPACE, complaints, 'Verify a reported correction at the ordinary entry point',
        'A complaint is evidence of a reported failure, not proof of its cause. Reproduce the reported behavior, retain a focused regression, and distinguish observed checks from an unverified completion claim. Memory observation must not suspend otherwise authorized work.', 0.45, ['learning-principle', 'verification']);
      const praised = rows.filter(row => observationFromRow(row).kind === 'praise');
      if (praised.length) save(GLOBAL_WORKSPACE, praised, 'Preserve procedures with evidence and uncertainty',
        'Keep reusable action, result and short public explanation summaries with source references and verification results. Praise and absence of complaints do not prove correctness. Exclude private reasoning, secrets, personal information and raw logs from shared principles.', 0.35, ['learning-principle', 'provenance']);
      return { accepted: true, recorded: routines + principles > 0, workMayContinue: true as const, saved: routines + principles, withdrawn: 0, routines, principles, warnings: [], diagnostics: [] };
    });
  } catch (error) { return learningFailure(error); }
}
