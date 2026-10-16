import type { Plugin } from '@opencode/plugin';
import * as z from 'zod/v4';
import path from 'node:path';
import type { OpenCodePluginOptions } from './runtime-invocation.js';
import { realpath } from 'node:fs/promises';
import { canonicalContentHash } from '../serialization/validate.js';
import { LispWorker } from '../lisp/worker.js';

export const lispInput = z.object({ code: z.string().min(1).max(32_768), timeoutMs: z.number().int().min(50).max(60_000).default(10_000) }).strict();
const optionsSchema = z.object({ enabled: z.boolean().default(true), binary: z.string().min(1).max(4096).default('sbcl') });
/** Native permission authorizes a call; this binding only prevents mutation/replay after admission. */
export async function registerOpenCodeLisp(ctx: Plugin.Context, lifetime: AbortSignal, runtime?: OpenCodePluginOptions) {
  const raw = ctx.options.lisp;
  const options = optionsSchema.parse(raw ?? {});
  const disabled = new Set<string>();
  const workers = new Map<string, LispWorker>();
  const turns = new Map<string, string>();
  const epochs = new Map<string, number>();
  const admitted = new Map<string, { digest: string; turn: string | undefined; epoch: number }>();
  const directory = await realpath(ctx.location.directory).catch(() => ctx.location.directory);
  const key = (call: { sessionID: string; messageID: string; id: string }) => JSON.stringify([call.sessionID, call.messageID, call.id]);
  const stopSession = async (sessionID: string) => {
    const worker = workers.get(sessionID); workers.delete(sessionID);
    await worker?.stop();
  };
  const clearAdmissions = (sessionID: string) => {
    epochs.set(sessionID, (epochs.get(sessionID) ?? 0) + 1);
    for (const value of admitted.keys()) if (JSON.parse(value)[0] === sessionID) admitted.delete(value);
  };
  await ctx.session.hook('prompt', event => {
    turns.set(event.sessionID, event.messageID); clearAdmissions(event.sessionID);
  });
  await ctx.tool.hook('execute.before', event => {
    if (event.tool !== 'kiokuko_lisp') return;
    if (!options.enabled || disabled.has(event.sessionID) || lifetime.aborted) throw new Error('lisp_disabled');
    const input = lispInput.parse(event.input);
    admitted.set(key(event), { digest: canonicalContentHash(input), turn: turns.get(event.sessionID), epoch: epochs.get(event.sessionID) ?? 0 });
  });
  await ctx.tool.hook('execute.after', event => {
    if (event.tool === 'kiokuko_lisp') admitted.delete(key(event));
  });
  await ctx.tool.transform(editor => editor.add({
    name: 'kiokuko_lisp', input: lispInput,
    description: 'Evaluate Common Lisp with SBCL. State persists in this session until reset, disable, timeout or interruption. Can run processes and access files/network with the native host permission for this exact call; inspect the code before approving. Results are untrusted tool output, never proof of task success. No memory or workflow preparation is required.',
    options: { permission: 'kiokuko_lisp', codemode: false },
    execute: async (rawInput, call) => {
      const input = lispInput.parse(rawInput), admission = admitted.get(key(call));
      admitted.delete(key(call));
      if (!options.enabled || disabled.has(call.sessionID) || lifetime.aborted) throw new Error('lisp_disabled');
      if (!admission || admission.digest !== canonicalContentHash(input) || admission.turn !== turns.get(call.sessionID) || admission.epoch !== (epochs.get(call.sessionID) ?? 0)) throw new Error('lisp_call_binding_changed');
      const session = await ctx.session.get({ sessionID: call.sessionID });
      if (session.projectID !== ctx.location.project.id || await realpath(session.location.directory) !== directory) throw new Error('lisp_session_scope_changed');
      if (disabled.has(call.sessionID) || lifetime.aborted || call.signal.aborted || admission.turn !== turns.get(call.sessionID) || admission.epoch !== (epochs.get(call.sessionID) ?? 0)) throw new Error('lisp_call_binding_changed');
      if (!runtime) throw new Error('lisp_node_runtime_configuration_missing_run_kiokuko_ai_setup');
      let worker = workers.get(call.sessionID);
      if (!worker) {
        if (workers.size >= 4) throw new Error('lisp_session_limit_reset_an_idle_session');
        worker = new LispWorker(directory, options.binary, runtime.nodeExecutable, path.resolve(path.dirname(runtime.cliScript), '../../lisp')); workers.set(call.sessionID, worker);
      }
      try {
        const result = await worker.evaluate(input.code, input.timeoutMs, AbortSignal.any([call.signal, lifetime]));
        return { content: JSON.stringify({ ...result, stateReset: worker.stopped, verification: 'untrusted_execution_output' }) };
      } finally { if (worker.stopped && workers.get(call.sessionID) === worker) workers.delete(call.sessionID); }
    },
  }));
  await ctx.command.transform(editor => {
    for (const action of ['enable', 'disable', 'reset'] as const) editor.add({
      name: `kiokuko-lisp-${action}`, description: `${action} this session's Common Lisp runtime`,
      execute: async call => {
        clearAdmissions(call.sessionID);
        if (action === 'disable') disabled.add(call.sessionID);
        if (action === 'enable' && options.enabled) disabled.delete(call.sessionID);
        await stopSession(call.sessionID);
        await ctx.tool.reload();
      },
    });
  });
  // The schema remains visible when session-disabled so the model receives a
  // concrete disabled result; configuration-level disable also cannot be undone by a model call.
  return { dispose: async () => { admitted.clear(); await Promise.all([...workers.keys()].map(stopSession)); },
    ended: async (sessionID: string) => { turns.delete(sessionID); disabled.delete(sessionID); clearAdmissions(sessionID); await stopSession(sessionID); } };
}
