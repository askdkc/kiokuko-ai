import { createHash, randomUUID } from 'node:crypto';
import { canonicalJson } from '../serialization/validate.js';
import { containsPrivateLearningData } from './learning-safety.js';
import { compactMemoryProposal } from './compact-proposal.js';

export interface ReplayMemoryProposal {
  schemaVersion: 1; proposalId: string; revision: number; title?: string; summary?: string;
  source: { kind?: 'unrecorded'; limitations?: string[]; taskOutcome?: 'completed' | 'failed'; workspace: string; taskId: string; sessionId: string; traces: Array<{ schemaVersion?: string; runId: string; eventsSha256: string; eventsRead: number; totalEvents: number | null; digestScope?: 'complete' | 'observed_prefix'; complete: boolean; gaps: string[] }> };
  request: { text: string; evidenceRefs: string[] };
  languages: Array<{ name: string; basis: 'observed' | 'inferred'; evidenceRefs: string[] }>;
  attempts: Array<{ taskId?: string | null; attemptId: string; tool: string; command?: string; arguments?: unknown; signal?: string; callRef: string; resultRef?: string;
    outcome: 'succeeded' | 'failed' | 'cancelled' | 'unknown'; execution: 'attempted' | 'started' | 'completed' | 'denied' | 'unknown';
    exitCode?: number; outputExcerpt?: string; payloadHashes: string[]; limitations: string[] }>;
  findings: Array<{ taskId?: string | null; kind: 'worked' | 'failed' | 'key_point'; text: string; basis: 'observed' | 'verified' | 'inferred' | 'user_corrected'; evidenceRefs: string[] }>;
  tags: string[]; keywords: string[];
}
export interface ReviewQuestion { id: string; phase: 'organize' | 'review'; text: string; details?: string; revision?: number; digest?: string; sourceKind?: 'unrecorded' }
export interface ReviewAnswer { questionId: string; choice: 'organize' | 'approve' | 'revise' | 'decline'; comment?: string }
export interface ReviewReceipt { status: 'saved' | 'declined' | 'unavailable' | 'not_completed'; workMayContinue: true; approvalKey?: string; reason?: 'native_elicitation_unavailable' }
export const proposalDigest = (value: ReplayMemoryProposal): string => createHash('sha256').update(canonicalJson(value)).digest('hex');

/** The displayed summary is the saved body; details contain only bounded provenance. */
function reviewSummary(proposal: ReplayMemoryProposal): string {
  const japanese = /[\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Han}]/u.test(proposal.request.text);
  return `${japanese ? 'この要約を同じリポジトリの記憶として保存しますか？' : 'Save this summary as memory for this repository?'}\n${proposal.summary}`;
}

/** Host-only adapter. Never expose ask/save or a human:true input through a model tool.
 * All candidates remain local until the exact displayed revision is approved.
 * A restart drops the closure. A signal/decline cannot be revived by late extraction.
 */
export async function reviewCompletedReplay(deps: {
  completed: boolean; taskOutcome?: 'completed' | 'failed'; taskId: string; sessionId: string; workspace: string; sourceKind?: 'unrecorded';
  extract: () => Promise<ReplayMemoryProposal>;
  ask: (question: ReviewQuestion) => Promise<ReviewAnswer>;
  save: (proposal: ReplayMemoryProposal, approvalKey: string) => Promise<void>;
  /** Host-only ephemeral retention after exact approval, for uncertain-save reconciliation. */
  onApproved?: (proposal: ReplayMemoryProposal, approvalKey: string) => void;
  signal?: AbortSignal;
}): Promise<ReviewReceipt> {
  const receipt = (status: ReviewReceipt['status']): ReviewReceipt => ({ status, workMayContinue: true });
  if (!deps.completed) return receipt('not_completed');
  const active = () => !deps.signal?.aborted;
  // Race host cancellation without letting its late promise resume this flow.
  async function wait<T>(operation: Promise<T>): Promise<T> {
    if (!active()) throw new Error('review_cancelled');
    let onAbort: (() => void) | undefined;
    const cancellation = new Promise<never>((_, reject) => {
      onAbort = () => reject(new Error('review_cancelled'));
      deps.signal?.addEventListener('abort', onAbort, { once: true });
    });
    try { return await Promise.race([operation, cancellation]); }
    finally { if (onAbort) deps.signal?.removeEventListener('abort', onAbort); }
  }
  let approvedKey: string | undefined;
  try {
    if (!active()) return receipt('declined');
    let proposal = structuredClone(await wait(deps.extract()));
    if ((deps.sourceKind === 'unrecorded') !== (proposal.source.kind === 'unrecorded') || proposal.schemaVersion !== 1 || proposal.source.workspace !== deps.workspace || proposal.source.taskId !== deps.taskId || proposal.source.sessionId !== deps.sessionId) throw new Error('proposal_binding_mismatch');
    proposal.proposalId = randomUUID(); proposal.revision = 1;
    if (deps.taskOutcome) proposal.source.taskOutcome = deps.taskOutcome;
    else if (deps.sourceKind !== 'unrecorded') proposal.source.taskOutcome = 'completed';
    if (Buffer.byteLength(JSON.stringify(proposal)) > 256 * 1024 || containsPrivateLearningData(proposal)) throw new Error('unsafe_proposal');
    proposal = compactMemoryProposal(proposal);
    for (;;) {
      if (!active()) return receipt('declined');
      if (Buffer.byteLength(JSON.stringify(proposal)) > 256 * 1024 || containsPrivateLearningData(proposal)) throw new Error('unsafe_proposal');
      const digest = proposalDigest(proposal);
      const question: ReviewQuestion = { id: randomUUID(), phase: 'review', revision: proposal.revision, digest,
        text: reviewSummary(proposal), details: JSON.stringify(proposal, null, 2) };
      const answer = await wait(deps.ask(question));
      if (answer.questionId !== question.id || !active()) return receipt('declined');
      if (answer.choice === 'decline') return receipt('declined');
      if (answer.choice === 'revise' || answer.comment?.trim()) {
        if (!answer.comment?.trim() || answer.comment.length > 2048 || answer.comment.trim().split('\n').length > 6 || containsPrivateLearningData(answer.comment)) throw new Error('unsafe_comment');
        // Corrections are attributed to the user, never forged as execution evidence.
        // The revised preview preserves observed evidence and explicitly supersedes prior interpretation.
        proposal = { ...proposal, revision: proposal.revision + 1, summary: answer.comment.trim(),
          findings: [{ kind: 'key_point', text: answer.comment.trim(), basis: 'user_corrected', evidenceRefs: [] }] };
        continue;
      }
      if (answer.choice !== 'approve' || proposalDigest(proposal) !== digest) return receipt('declined');
      const approvalKey = createHash('sha256').update(JSON.stringify([deps.workspace, deps.taskId, deps.sessionId, proposal.proposalId, proposal.revision, digest])).digest('hex');
      if (!active()) return receipt('declined');
      approvedKey = approvalKey;
      deps.onApproved?.(structuredClone(proposal), approvalKey);
      await deps.save(structuredClone(proposal), approvalKey);
      return { status: 'saved', workMayContinue: true, approvalKey };
    }
  } catch { return { ...receipt(approvedKey || active() ? 'unavailable' : 'declined'), ...(approvedKey ? { approvalKey: approvedKey } : {}) }; }
}
