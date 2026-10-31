import { fileURLToPath } from 'node:url';
/** Package-owned Node worker for the native TUI. Not a CLI or model-callable tool. */
import { existsSync } from 'node:fs';
import { lstat, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { getGlobalDatabasePath } from '../config/paths.js';
import { openConnection } from '../db/connection.js';
import { resolveProjectWorkspaceReadOnly, resolveProjectWorkspace } from '../memory/workspaces.js';
import { createApprovedReplayMemoryStore } from '../memory/replay-store.js';
import { extractReplayProposal } from '../memory/replay-extract.js';
import { unrecordedDraftSchema, unrecordedProposal, type UnrecordedDraft } from '../memory/unrecorded-review.js';
import { reviewCompletedReplay, type ReviewAnswer, type ReviewQuestion, type ReviewReceipt, type ReplayMemoryProposal } from '../memory/replay-review.js';
import { recordEntryInTransaction } from '../memory/entries.js';
import { buildStructuredScope } from '../memory/structured-memory.js';

export interface ApprovedReplayRecovery { proposal: ReplayMemoryProposal; approvalKey: string }
export interface ReplayReviewStart { cwd: string; traceDirectory?: string; unrecordedDraft?: UnrecordedDraft; taskId: string; sessionId: string; taskOutcome?: 'completed' | 'failed'; approvedRecovery?: ApprovedReplayRecovery }

/** Resolve existing symlinks even when the final recording directory does not yet exist. */
async function canonicalProspectivePath(value: string): Promise<string> {
  let current = value;
  const missing: string[] = [];
  for (;;) {
    try { return path.resolve(await realpath(current), ...missing.reverse()); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      // A dangling symlink is not an absent ordinary path and must not be followed or ignored.
      try { await lstat(current); throw new Error('unresolvable_recording_path'); }
      catch (statError) { if ((statError as NodeJS.ErrnoException).code !== 'ENOENT') throw statError; }
      const parent = path.dirname(current);
      if (parent === current) throw error;
      missing.push(path.basename(current)); current = parent;
    }
  }
}

function isDescendant(root: string, value: string): boolean {
  const relative = path.relative(root, value);
  return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

/** An empty/missing scoped directory is no recording; partial recordings retain integrity checks. */
async function recordingPresent(directory: string, root: string): Promise<boolean> {
  if (!path.isAbsolute(directory)) throw new Error('invalid_recording_path');
  const runs = await canonicalProspectivePath(path.join(root, '.agenticreplay', 'runs'));
  const target = await canonicalProspectivePath(directory);
  if (!isDescendant(root, runs) || !isDescendant(runs, target)) throw new Error('recording_scope_mismatch');
  try {
    if (!(await stat(target)).isDirectory()) return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
  for (const name of ['manifest.json', 'events.jsonl', 'event.jsonl']) {
    try { await lstat(path.join(target, name)); return true; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
  return false;
}

export async function runNativeReplayReview(input: ReplayReviewStart, ask: (q: ReviewQuestion) => Promise<ReviewAnswer>, signal?: AbortSignal, onApproved?: (proposal: ReplayMemoryProposal, key: string) => void | Promise<void>): Promise<ReviewReceipt> {
  const databasePath = getGlobalDatabasePath();
  // Review does not create a database, repository mapping, proposal file or audit entry.
  if (!existsSync(databasePath)) return { status: 'unavailable', workMayContinue: true };
  const reading = openConnection(databasePath, { readOnly: true });
  const project = await resolveProjectWorkspaceReadOnly(reading, input.cwd).finally(() => reading.close());
  if (!project) return { status: 'unavailable', workMayContinue: true };
  const recovery = input.approvedRecovery;
  if (recovery) {
    if (recovery.proposal.source.workspace !== project.workspace || recovery.proposal.source.taskId !== input.taskId || recovery.proposal.source.sessionId !== input.sessionId) return { status: 'unavailable', workMayContinue: true };
    const db = openConnection(databasePath, { readOnly: true });
    try { return { status: createApprovedReplayMemoryStore(db, project.workspace).reconcile(recovery.proposal, recovery.approvalKey), workMayContinue: true, approvalKey: recovery.approvalKey }; }
    finally { db.close(); }
  }
  let traceDirectory = input.traceDirectory;
  if (traceDirectory) {
    try { if (!await recordingPresent(traceDirectory, project.repositoryRoot)) traceDirectory = undefined; }
    catch { return { status: 'unavailable', workMayContinue: true }; }
  }
  const draft = traceDirectory ? undefined : unrecordedDraftSchema.safeParse(input.unrecordedDraft);
  if (!traceDirectory && !draft?.success) return { status: 'unavailable', workMayContinue: true };
  let approvalRetained: void | Promise<void>;
  return reviewCompletedReplay({ completed: true, ...input, workspace: project.workspace,
    ...(!traceDirectory ? { sourceKind: 'unrecorded' as const } : {}),
    ...(signal ? { signal } : {}), ...(onApproved ? { onApproved: (proposal: ReplayMemoryProposal, key: string) => { approvalRetained = onApproved(proposal, key); } } : {}),
    ask: question => ask(question.phase === 'organize' && traceDirectory ? { ...question,
      text: `If this task has ended${input.taskOutcome === 'failed' ? ' with a failed outcome' : ''}, may I organize the recorded run into proposed memories?\n${traceDirectory}\nA recording can span several requests or sessions. You will review its exact scope and contents before anything is saved. Decline if you are still working.` } : question),
    extract: () => traceDirectory
      ? extractReplayProposal({ ...input, traceDirectory, cwd: project.repositoryRoot, workspace: project.workspace })
      : Promise.resolve(unrecordedProposal({ workspace: project.workspace, taskId: input.taskId, sessionId: input.sessionId, draft: draft!.data! })),
    save: async (proposal, key) => {
      await approvalRetained;
      if (signal?.aborted) throw new Error('review_cancelled');
      const database = openConnection(databasePath);
      try {
        const current = await resolveProjectWorkspace(database, input.cwd);
        if (!current || current.workspace !== project.workspace || current.repositoryRoot !== project.repositoryRoot || signal?.aborted) throw new Error('review_binding_changed');
        createApprovedReplayMemoryStore(database, project.workspace, (approved, approvalKey) => {
          return recordEntryInTransaction(database, { workspace: project.workspace, kind: 'lesson', status: 'candidate', trustLevel: 'untrusted',
            title: approved.title ?? `Reviewed recorded experience: ${approved.request.text.slice(0, 100) || approved.source.taskId}`,
            body: [approved.source.kind === 'unrecorded' ? 'User-reviewed unrecorded experience; claims are unverified.' : 'Approved recorded-experience excerpt. Full revision is retained in the replay store.', approved.request.text, ...approved.findings.map(finding => finding.text)].join('\n').slice(0, 19000), tags: approved.tags, confidence: 0.5,
            scope: buildStructuredScope({ visibility: 'project', retrievalScope: 'project-only', repositoryId: project.repositoryId, memoryClass: 'workflow' }),
            provenance: { type: approved.source.kind === 'unrecorded' ? 'user_reviewed_unrecorded' : 'user_reviewed_replay', reference: approvalKey, sourceRepositoryId: project.repositoryId, sourceWorkspace: project.workspace }, createdBy: 'kiokuko-ai-user-review' });
        }).save(proposal, key);
      } finally { database.close(); }
    },
  });
}

// The anonymous IPC channel belongs to the native adapter, not MCP or model output.
if (process.send && process.argv[1] === fileURLToPath(import.meta.url)) {
  let started = false;
  const controller = new AbortController();
  process.once('disconnect', () => controller.abort());
  process.on('message', async message => {
    const value = message as { type?: string; input?: ReplayReviewStart };
    if (value.type !== 'start' || started || !value.input) return;
    started = true;
    const ask = (question: ReviewQuestion) => new Promise<ReviewAnswer>((resolve, reject) => {
      const receive = (raw: unknown) => {
        const reply = raw as { type?: string; answer?: ReviewAnswer };
        if (reply.type !== 'answer' || reply.answer?.questionId !== question.id) return;
        process.off('message', receive); resolve(reply.answer);
      };
      process.on('message', receive);
      process.send?.({ type: 'question', question }, error => { if (error) { process.off('message', receive); reject(error); } });
    });
    try {
      const receipt = await runNativeReplayReview(value.input, ask, controller.signal, (proposal, approvalKey) => new Promise<void>((resolve, reject) => {
        const receive = (raw: unknown) => {
          const reply = raw as { type?: string; approvalKey?: string };
          if (reply.type !== 'approved-retained' || reply.approvalKey !== approvalKey) return;
          process.off('message', receive); resolve();
        };
        process.on('message', receive);
        process.send?.({ type: 'approved', recovery: { proposal, approvalKey } }, error => { if (error) { process.off('message', receive); reject(error); } });
      }));
      process.send?.({ type: 'receipt', receipt }, () => process.disconnect());
    } catch { process.send?.({ type: 'receipt', receipt: { status: 'unavailable', workMayContinue: true } }, () => process.disconnect()); }
  });
}
