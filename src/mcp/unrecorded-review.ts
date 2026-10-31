import { createHash } from 'node:crypto';
import { realpath } from 'node:fs/promises';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import * as z from 'zod/v4';
import type { SqliteDatabase } from '../db/adapter.js';
import { absoluteCwdSchema } from '../repository/cwd-schema.js';
import { canonicalJson } from '../serialization/validate.js';
import { resolveProjectWorkspace, resolveProjectWorkspaceReadOnly } from '../memory/workspaces.js';
import { recordEntryInTransaction } from '../memory/entries.js';
import { createApprovedReplayMemoryStore } from '../memory/replay-store.js';
import { reviewCompletedReplay, type ReplayMemoryProposal, type ReviewReceipt } from '../memory/replay-review.js';
import { unrecordedDraftSchema, unrecordedProposal } from '../memory/unrecorded-review.js';

export const unrecordedReviewInputSchema = z.object({
  cwd: absoluteCwdSchema.max(4096),
  requestId: z.string().min(1).max(256).regex(/^[\w.:-]+$/u),
  draft: unrecordedDraftSchema,
}).strict();
type ReviewInput = z.infer<typeof unrecordedReviewInputSchema>;

type ReviewState = {
  digest: string;
  active: boolean;
  approved?: { proposal: ReplayMemoryProposal; key: string };
  receipt?: ReviewReceipt;
};

/** A native MCP dialog, not a model-supplied flag, owns consent and exact approval. */
export function createMcpUnrecordedReview(server: McpServer, withDatabase: <T>(fn: (db: SqliteDatabase) => Promise<T> | T) => Promise<T>) {
  const states = new Map<string, ReviewState>();
  const abort = new AbortController();
  const unavailable = (): ReviewReceipt => ({ status: 'unavailable', workMayContinue: true });
  return {
    close() { abort.abort(); },
    async review(input: ReviewInput, signal?: AbortSignal): Promise<ReviewReceipt> {
      const digest = createHash('sha256').update(canonicalJson(input)).digest('hex');
      const existing = states.get(input.requestId);
      if (existing && existing.digest !== digest) return unavailable();
      if (existing?.receipt) return existing.receipt;
      if (existing?.active) return unavailable();
      if (existing?.approved) {
        const pending = existing.approved;
        try {
          const state = await withDatabase(db => createApprovedReplayMemoryStore(db, pending.proposal.source.workspace).reconcile(pending.proposal, pending.key));
          const receipt: ReviewReceipt = { status: state, workMayContinue: true, approvalKey: pending.key };
          if (state === 'saved') { existing.receipt = receipt; delete existing.approved; }
          return receipt;
        } catch { return { ...unavailable(), approvalKey: pending.key }; }
      }
      if (!server.server.getClientCapabilities()?.elicitation) return { ...unavailable(), reason: 'native_elicitation_unavailable' };
      if (states.size >= 256 || abort.signal.aborted || signal?.aborted) return unavailable();
      const state: ReviewState = { digest, active: true };
      states.set(input.requestId, state);
      const combined = signal ? AbortSignal.any([signal, abort.signal]) : abort.signal;
      try {
        const cwd = await realpath(input.cwd);
        const project = await withDatabase(db => resolveProjectWorkspaceReadOnly(db, cwd));
        if (!project || combined.aborted) return unavailable();
        const taskId = input.requestId;
        const sessionId = `unrecorded:${input.requestId}`;
        const receipt = await reviewCompletedReplay({
          completed: true, sourceKind: 'unrecorded', taskId, sessionId, workspace: project.workspace, signal: combined,
          extract: async () => unrecordedProposal({ workspace: project.workspace, taskId, sessionId, draft: input.draft }),
          ask: async question => {
            const choices = question.phase === 'organize' ? ['organize', 'decline'] : ['approve', 'revise', 'decline'];
            const result = await server.server.elicitInput({ mode: 'form', message: question.text,
              requestedSchema: { type: 'object', properties: { choice: { type: 'string', enum: choices }, comment: { type: 'string', maxLength: 2048 } }, required: ['choice'] } },
            { signal: combined, timeout: 300_000 });
            const choice = result.action === 'accept' ? result.content?.choice : 'decline';
            return { questionId: question.id, choice: choice === 'organize' || choice === 'approve' || choice === 'revise' ? choice : 'decline',
              ...(typeof result.content?.comment === 'string' ? { comment: result.content.comment } : {}) };
          },
          onApproved: (proposal, key) => { state.approved = { proposal, key }; },
          save: async (proposal, key) => withDatabase(async db => {
            if (combined.aborted) throw new Error('review_cancelled');
            const current = await resolveProjectWorkspaceReadOnly(db, cwd);
            if (!current || current.workspace !== project.workspace || current.repositoryId !== project.repositoryId
              || current.repositoryRoot !== project.repositoryRoot || combined.aborted) throw new Error('review_binding_changed');
            const registered = await resolveProjectWorkspace(db, cwd);
            if (!registered || registered.workspace !== project.workspace || registered.repositoryId !== project.repositoryId
              || registered.repositoryRoot !== project.repositoryRoot || combined.aborted) throw new Error('review_binding_changed');
            createApprovedReplayMemoryStore(db, project.workspace, p => recordEntryInTransaction(db, {
              workspace: project.workspace, kind: 'reference', title: p.title!,
              body: ['User-reviewed unrecorded experience; claims are unverified.', p.request.text, ...p.findings.map(f => f.text)].join('\n').slice(0, 19000),
              summary: p.findings.map(f => f.text).join('\n').slice(0, 2048),
              tags: p.tags, scope: { visibility: 'project' },
              provenance: { type: 'user_approved_unrecorded', reference: key, sourceRepositoryId: project.repositoryId, sourceWorkspace: project.workspace },
              trustLevel: 'untrusted', confidence: 0.4, createdBy: 'kiokuko-ai-user-review', actor: 'user',
            })).save(proposal, key);
          }),
        });
        if (receipt.status === 'saved' || receipt.status === 'declined') { state.receipt = receipt; delete state.approved; }
        return receipt;
      } catch { return unavailable(); }
      finally {
        state.active = false;
        if (!state.receipt && !state.approved) states.delete(input.requestId);
      }
    },
  };
}
