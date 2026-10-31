import * as z from 'zod/v4';
import { containsPrivateLearningData } from './learning-safety.js';
import type { ReplayMemoryProposal } from './replay-review.js';

const publicText = (maximum: number) => z.string().trim().min(1).max(maximum)
  .refine(value => !/[\p{Cc}\p{Cf}]/u.test(value.replaceAll('\n', '').replaceAll('\t', '')));

/** Model- or host-supplied draft: content is data, never evidence of human approval. */
export const unrecordedDraftSchema = z.object({
  title: publicText(200),
  request: publicText(4096),
  body: publicText(12000),
  tags: z.array(publicText(64)).max(20).default([]),
  keywords: z.array(publicText(64)).max(64).default([]),
  sourceNotes: z.array(publicText(512)).max(10).default([]),
}).strict().refine(value => !containsPrivateLearningData(value) && Buffer.byteLength(JSON.stringify(value)) <= 32 * 1024);

export type UnrecordedDraft = z.infer<typeof unrecordedDraftSchema>;

/** Construct an explicitly unverified proposal without inventing a trace or test results. */
export function unrecordedProposal(input: {
  workspace: string; taskId: string; sessionId: string; draft: UnrecordedDraft;
}): ReplayMemoryProposal {
  const draft = unrecordedDraftSchema.parse(input.draft);
  const terms = `${draft.title} ${draft.request}`.toLowerCase()
    .match(/[\p{L}\p{N}_.-]{2,64}/gu) ?? [];
  return {
    schemaVersion: 1, proposalId: '', revision: 1, title: draft.title,
    source: { workspace: input.workspace, taskId: input.taskId, sessionId: input.sessionId,
      kind: 'unrecorded', traces: [], limitations: [
        'No AgenticReplay recording was supplied. The draft is untrusted and its claims have not been independently verified.',
        ...draft.sourceNotes,
      ] },
    request: { text: draft.request, evidenceRefs: [] },
    languages: [], attempts: [],
    findings: [{ kind: 'key_point', text: draft.body, basis: 'inferred', evidenceRefs: [] }],
    tags: draft.tags, keywords: [...new Set([...draft.keywords, ...terms])].slice(0, 64),
  };
}
