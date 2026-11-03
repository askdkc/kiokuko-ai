import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ReviewAnswer, ReviewQuestion } from '../memory/replay-review.js';

/** Native form consent, with full proposal content available only on request. */
export async function askMcpReviewQuestion(server: McpServer, question: ReviewQuestion, signal: AbortSignal): Promise<ReviewAnswer> {
  const choices = question.phase === 'organize' ? ['organize', 'decline'] : ['approve', 'revise', 'decline', ...(question.details ? ['details'] : [])];
  const labels: Record<string, string> = { organize: 'Create proposal', approve: 'Save memory', revise: 'Edit key points', decline: 'Skip — do not save', details: 'Details — view full content' };
  let message = question.text;
  for (;;) {
    const result = await server.server.elicitInput({ mode: 'form', message,
      requestedSchema: { type: 'object', properties: {
        choice: { type: 'string', title: 'Action', oneOf: choices.map(value => ({ const: value, title: labels[value]! })) },
        comment: { type: 'string', title: 'New key points (only when editing)', maxLength: 2048 },
      }, required: ['choice'] } }, { signal, timeout: 300_000 });
    const choice = result.action === 'accept' ? result.content?.choice : 'decline';
    if (choice === 'details' && question.details) {
      message = `${question.details}\nSave / Edit / Skip — applies to this full revision.`;
      continue;
    }
    return { questionId: question.id, choice: choice === 'organize' || choice === 'approve' || choice === 'revise' ? choice : 'decline',
      ...(typeof result.content?.comment === 'string' ? { comment: result.content.comment } : {}) };
  }
}
