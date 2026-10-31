import type { Plugin } from '@opencode/plugin/tui';
import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { trustedInvocation } from './hook-effect.js';
import { parseOpenCodePluginOptions } from './runtime-invocation.js';
import { v2EventSession } from './v2-adapter.js';
import type { ReplayReviewStart, ApprovedReplayRecovery } from './replay-review-worker.js';
import type { ReviewAnswer, ReviewQuestion, ReviewReceipt } from '../memory/replay-review.js';
import { containsPrivateLearningData } from '../memory/learning-safety.js';
import type { UnrecordedDraft } from '../memory/unrecorded-review.js';

/** Actual native dialogs return answers directly; model text cannot supply approval. */
export async function askNativeReplayQuestion(ctx: Plugin.Context, question: ReviewQuestion): Promise<ReviewAnswer> {
  if (question.phase === 'organize') {
    const yes = await ctx.ui.dialog.confirm({ title: question.sourceKind === 'unrecorded' ? 'Create memory without a recording?' : 'Organize recorded experience?', message: question.text,
      label: { confirm: question.sourceKind === 'unrecorded' ? 'Create proposal' : 'Organize', cancel: 'No, finish without saving' } });
    return { questionId: question.id, choice: yes === true ? 'organize' : 'decline' };
  }
  // Exact canonical revision is visible before the approve/revise decision.
  await ctx.ui.dialog.alert({ title: `Proposed memory revision ${question.revision}`, message: question.text });
  const choice = await ctx.ui.dialog.select({ title: `Save reviewed revision ${question.revision}?`, options: [
    { title: 'Save this exact revision', value: 'approve' },
    { title: 'Revise the proposed findings', value: 'revise' },
    { title: 'Finish without saving', value: 'decline' },
  ] });
  if (choice !== 'revise') return { questionId: question.id, choice: choice === 'approve' ? 'approve' : 'decline' };
  const comment = await ctx.ui.dialog.prompt({ title: 'Revise proposed memory', description: 'Describe the corrected findings. Recorded evidence remains attributed to its source; the revised proposal will be shown again.' });
  return comment?.trim() ? { questionId: question.id, choice: 'revise', comment } : { questionId: question.id, choice: 'decline' };
}

export type NativeReviewRunner = (input: ReplayReviewStart, nodeExecutable: string, ask: (q: ReviewQuestion) => Promise<ReviewAnswer>, signal: AbortSignal, onApproved?: (recovery: ApprovedReplayRecovery) => void) => Promise<ReviewReceipt>;
export const runNativeReviewWorker: NativeReviewRunner = (input, nodeExecutable, ask, signal, onApproved) => new Promise(resolve => {
  const child = fork(fileURLToPath(new URL('./replay-review-worker.js', import.meta.url)), [], {
    execPath: nodeExecutable, execArgv: [], cwd: input.cwd, stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
  });
  let done = false, asking = false;
  let approvedIdentity = input.approvedRecovery;
  const timer = setTimeout(() => finish({ status: 'declined', workMayContinue: true }), 30 * 60_000);
  timer.unref?.();
  const finish = (receipt: ReviewReceipt) => { if (done) return; done = true; clearTimeout(timer); signal.removeEventListener('abort', abort); child.kill(); resolve(receipt.status !== 'saved' && approvedIdentity ? { status: 'unavailable', workMayContinue: true, approvalKey: approvedIdentity.approvalKey } : receipt); };
  const abort = () => finish({ status: 'declined', workMayContinue: true });
  signal.addEventListener('abort', abort, { once: true });
  child.on('error', () => finish({ status: 'unavailable', workMayContinue: true }));
  child.on('exit', () => finish({ status: 'unavailable', workMayContinue: true }));
  child.on('message', async raw => {
    if (done || signal.aborted || !raw || typeof raw !== 'object') return;
    const message = raw as { type?: string; question?: ReviewQuestion; receipt?: ReviewReceipt; recovery?: ApprovedReplayRecovery };
    if (message.type === 'approved' && message.recovery && Buffer.byteLength(JSON.stringify(message)) <= 300 * 1024) {
      approvedIdentity = structuredClone(message.recovery);
      try {
        onApproved?.(structuredClone(approvedIdentity));
        child.send({ type: 'approved-retained', approvalKey: approvedIdentity.approvalKey });
      } catch { finish({ status: 'unavailable', workMayContinue: true }); }
      return;
    }
    if (message.type === 'receipt' && message.receipt) { finish(message.receipt); return; }
    if (message.type !== 'question' || !message.question || asking || Buffer.byteLength(JSON.stringify(message)) > 300 * 1024) return;
    asking = true;
    try { const answer = await ask(message.question); if (!done && !signal.aborted) child.send({ type: 'answer', answer }); }
    catch { abort(); } finally { asking = false; }
  });
  if (signal.aborted) abort(); else child.send({ type: 'start', input });
});

/** Capture bounded public excerpts without fenced code or block-quoted lines. */
function sessionExcerpt(value: unknown): string {
  if (typeof value !== 'string' || value.length > 64 * 1024 || containsPrivateLearningData(value)) return '';
  return value.replace(/```[\s\S]*?(?:```|$)/gu, '').split('\n')
    .filter(line => !/^\s*>/u.test(line)).join(' ').replace(/[\p{Cc}\p{Cf}]/gu, ' ')
    .replace(/\s+/gu, ' ').trim().slice(0, 1800);
}

function sessionDraft(request: unknown, response: string): UnrecordedDraft {
  const safeRequest = sessionExcerpt(request);
  const safeResponse = sessionExcerpt(response);
  return {
    title: safeRequest.slice(0, 120) || 'Unrecorded session experience',
    request: safeRequest || 'The public request was unavailable or excluded.',
    body: safeResponse || 'The public final response was unavailable or excluded; no task result is established.',
    tags: [], keywords: [], sourceNotes: [
      'Bounded excerpts from the latest OpenCode request and public final response; fenced code and block-quoted lines are omitted.',
      'Assistant statements are unverified; no command output or private reasoning was extracted.',
    ],
  };
}

/** Successful idle is necessary, but human organization consent also confirms the task is finished. */
export async function registerNativeReplayReview(ctx: Plugin.Context, run: NativeReviewRunner = runNativeReviewWorker) {
  const runtime = parseOpenCodePluginOptions(ctx.options);
  const traceDirectory = process.env.AGENTICREPLAY_RUN_DIR;
  if (!runtime || !ctx.location) return () => undefined;
  if (run === runNativeReviewWorker && !(await trustedInvocation({ runtime })).argv) return () => undefined;
  const directory = ctx.location.directory;
  const reviewed = new Set<string>();
  // Only already-approved revisions enter this cache. Recovery never extracts or writes.
  const approvedRecoveries = new Map<string, ApprovedReplayRecovery>();
  let active: { sessionId: string; controller: AbortController } | undefined;
  let disposed = false;
  const current = (sessionId: string) => { const route = ctx.ui.router.current(); return !disposed && route.type === 'session' && route.sessionID === sessionId; };
  const unsubscribe = ctx.data.listen(({ details }) => {
    const event = v2EventSession(details);
    if (!event) return;
    if (/^session\.execution\.(?:started|interrupted|failed)$/u.test(event.type) && active?.sessionId === event.sessionId) active.controller.abort();
    if (!['session.execution.succeeded', 'session.execution.failed'].includes(event.type) || active || !current(event.sessionId)) return;
    const controller = new AbortController(); active = { sessionId: event.sessionId, controller };
    void (async () => {
      const session = await ctx.client.session.get({ sessionID: event.sessionId });
      if (session.id !== event.sessionId || session.parentID || session.location.directory !== directory || !current(event.sessionId)) return;
      const messages = await ctx.client.session.context({ sessionID: event.sessionId });
      const last = messages.at(-1);
      const assistant = [...messages].reverse().find(m => m.type === 'assistant');
      const user = [...messages].reverse().find(m => m.type === 'user');
      if (last?.type !== 'idle' || !['succeeded', 'failed'].includes(last.outcome) || assistant?.type !== 'assistant'
        || assistant.finish !== 'stop' || assistant.time.completed === undefined || !user
        || messages.indexOf(user) >= messages.indexOf(assistant)
        || assistant.content.some(p => p.type === 'tool' && (p.state.status === 'running' || p.state.status === 'streaming'))
        || !assistant.content.some(p => p.type === 'text' && p.text.trim())
        || ctx.data.session.pending.list(event.sessionId).length || controller.signal.aborted) return;
      // A native MCP form already queued by this exact request owns its review.
      // Do not open a second TUI dialog for the same completion.
      const queuedByMcp = messages.slice(messages.indexOf(user) + 1).some(message => message.type === 'assistant'
        && message.content.some(part => part.type === 'tool' && /(?:^|_)memory_checkpoint$/u.test(part.name)
          && part.state.status === 'completed' && part.state.content.some(content => {
            if (content.type !== 'text') return false;
            try { return JSON.parse(content.text)?.memoryReview?.status === 'queued'; } catch { return false; }
          })));
      const reviewedByMcp = messages.slice(messages.indexOf(user) + 1).some(message => message.type === 'assistant'
        && message.content.some(part => part.type === 'tool' && /(?:^|_)memory_review_(?:completed|unrecorded)$/u.test(part.name)
          && part.state.status === 'completed' && part.state.content.some(content => {
            if (content.type !== 'text') return false;
            try { return ['saved', 'declined'].includes(JSON.parse(content.text)?.status); } catch { return false; }
          })));
      if (queuedByMcp || reviewedByMcp) return;
      const taskId = user.id;
      const key = `${event.sessionId}:${taskId}`;
      if (reviewed.has(key) || (approvedRecoveries.size >= 256 && !approvedRecoveries.has(key))) return;
      reviewed.add(key);
      // Bounded volatile dedup; restart intentionally drops all candidate/approval state.
      if (reviewed.size > 1024) reviewed.delete(reviewed.values().next().value!);
      const recovery = approvedRecoveries.get(key);
      const publicResponse = assistant.content.flatMap(part => part.type === 'text' ? [part.text] : []).join('\n');
      const draft = sessionDraft(user.text, publicResponse);
      const receipt = await run({ ...(recovery ? { approvedRecovery: recovery } : {}), cwd: directory, ...(traceDirectory ? { traceDirectory } : {}), unrecordedDraft: draft, taskId, sessionId: event.sessionId, taskOutcome: last.outcome === 'failed' ? 'failed' : 'completed' }, runtime.nodeExecutable,
        async q => {
          if (!current(event.sessionId) || controller.signal.aborted) return { questionId: q.id, choice: 'decline' };
          const answer = await askNativeReplayQuestion(ctx, q);
          return current(event.sessionId) && !controller.signal.aborted ? answer : { questionId: q.id, choice: 'decline' };
        }, controller.signal, approved => approvedRecoveries.set(key, structuredClone(approved)));
      if (receipt.status === 'saved') approvedRecoveries.delete(key);
      if (receipt.status === 'unavailable') reviewed.delete(key);
      if (receipt.status === 'unavailable' && current(event.sessionId)) ctx.ui.toast.show({ title: 'Memory review unavailable', message: 'The task remains finished. The memory save could not be confirmed; check saved memory before retrying.', variant: 'warning' });
    })().catch(() => undefined).finally(() => { if (active?.controller === controller) active = undefined; });
  });
  return () => { disposed = true; unsubscribe(); active?.controller.abort(); };
}

export const KiokukoTuiPlugin: Plugin.Definition = { id: 'kiokuko-ai', setup: registerNativeReplayReview };
export default KiokukoTuiPlugin;
