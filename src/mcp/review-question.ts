import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ReviewAnswer, ReviewQuestion } from '../memory/replay-review.js';

/** Native form consent, with full proposal content available only on request. */
export async function askMcpReviewQuestion(server: McpServer, question: ReviewQuestion, signal: AbortSignal): Promise<ReviewAnswer> {
  const choices = question.phase === 'organize' ? ['organize', 'decline'] : ['approve', 'revise', 'decline', ...(question.details ? ['details'] : [])];
  const japanese = /[\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Han}]/u.test(question.text);
  const labels: Record<string, string> = japanese
    ? { organize: '要約を作成', approve: 'この要約を保存', revise: '要約を修正', decline: '保存しない', details: '詳細と出典を確認' }
    : { organize: 'Create summary', approve: 'Save this summary', revise: 'Edit summary', decline: 'Skip — do not save', details: 'Details and provenance' };
  let message = question.text;
  for (;;) {
    const result = await server.server.elicitInput({ mode: 'form', message,
      requestedSchema: { type: 'object', properties: {
        choice: { type: 'string', title: 'Action', oneOf: choices.map(value => ({ const: value, title: labels[value]! })) },
      }, required: ['choice'] } }, { signal, timeout: 300_000 });
    const choice = result.action === 'accept' ? result.content?.choice : 'decline';
    if (choice === 'details' && question.details) {
      message = `${question.details}\n${question.text}`;
      continue;
    }
    if (choice === 'revise') {
      const edited = await server.server.elicitInput({ mode: 'form',
        message: japanese ? '保存する要約を6行以内で入力してください。修正後にもう一度確認します。' : 'Replace the summary in up to six lines. You will review it again before saving.',
        requestedSchema: { type: 'object', properties: {
          summary: { type: 'string', title: japanese ? '保存する要約' : 'Summary to save', minLength: 1, maxLength: 2048 },
        }, required: ['summary'] } }, { signal, timeout: 300_000 });
      return edited.action === 'accept' && typeof edited.content?.summary === 'string'
        ? { questionId: question.id, choice: 'revise', comment: edited.content.summary }
        : { questionId: question.id, choice: 'decline' };
    }
    return { questionId: question.id, choice: choice === 'organize' || choice === 'approve' || choice === 'revise' ? choice : 'decline',
      ...(typeof result.content?.comment === 'string' ? { comment: result.content.comment } : {}) };
  }
}
