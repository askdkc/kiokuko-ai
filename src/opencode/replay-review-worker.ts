import { fileURLToPath } from 'node:url';
/** Package-owned Node worker for the native TUI. Not a CLI or model-callable tool. */
import { existsSync } from 'node:fs';
import { getGlobalDatabasePath } from '../config/paths.js';
import { openConnection } from '../db/connection.js';
import { resolveProjectWorkspaceReadOnly, resolveProjectWorkspace } from '../memory/workspaces.js';
import { createApprovedReplayMemoryStore } from '../memory/replay-store.js';
import { extractReplayProposal } from '../memory/replay-extract.js';
import { reviewCompletedReplay, type ReviewAnswer, type ReviewQuestion, type ReviewReceipt, type ReplayMemoryProposal } from '../memory/replay-review.js';
import { recordEntryInTransaction } from '../memory/entries.js';
import { buildStructuredScope } from '../memory/structured-memory.js';

export interface ApprovedReplayRecovery { proposal: ReplayMemoryProposal; approvalKey: string }
export interface ReplayReviewStart { cwd: string; traceDirectory: string; taskId: string; sessionId: string; taskOutcome?: 'completed' | 'failed'; approvedRecovery?: ApprovedReplayRecovery }

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
  let approvalRetained: void | Promise<void>;
  return reviewCompletedReplay({ completed: true, ...input, workspace: project.workspace,
    ...(signal ? { signal } : {}), ...(onApproved ? { onApproved: (proposal: ReplayMemoryProposal, key: string) => { approvalRetained = onApproved(proposal, key); } } : {}),
    ask: question => ask(question.phase === 'organize' ? { ...question,
      text: `If this task has ended${input.taskOutcome === 'failed' ? ' with a failed outcome' : ''}, may I organize the recorded run into proposed memories?\n${input.traceDirectory}\nA recording can span several requests or sessions. You will review its exact scope and contents before anything is saved. Decline if you are still working.` } : question),
    extract: () => extractReplayProposal({ ...input, cwd: project.repositoryRoot, workspace: project.workspace }),
    save: async (proposal, key) => {
      await approvalRetained;
      if (signal?.aborted) throw new Error('review_cancelled');
      const database = openConnection(databasePath);
      try {
        const current = await resolveProjectWorkspace(database, input.cwd);
        if (!current || current.workspace !== project.workspace || current.repositoryRoot !== project.repositoryRoot || signal?.aborted) throw new Error('review_binding_changed');
        createApprovedReplayMemoryStore(database, project.workspace, (approved, approvalKey) => {
          return recordEntryInTransaction(database, { workspace: project.workspace, kind: 'lesson', status: 'candidate', trustLevel: 'untrusted',
            title: `Reviewed recorded experience: ${approved.request.text.slice(0, 100) || approved.source.taskId}`,
            body: ['Approved recorded-experience excerpt. Full revision is retained in the replay store.', approved.request.text, ...approved.findings.map(finding => finding.text)].join('\n').slice(0, 19000), tags: approved.tags, confidence: 0.5,
            scope: buildStructuredScope({ visibility: 'project', retrievalScope: 'project-only', repositoryId: project.repositoryId, memoryClass: 'workflow' }),
            provenance: { type: 'user_reviewed_replay', reference: approvalKey, sourceRepositoryId: project.repositoryId, sourceWorkspace: project.workspace }, createdBy: 'kiokuko-ai-user-review' });
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
