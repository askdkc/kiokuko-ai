import type { Plugin } from '@opencode-ai/plugin';
import {
  createOpenCodeIdleHandler,
  KIOKUKO_OPENCODE_API_TIMEOUT_MS,
  KIOKUKO_OPENCODE_MESSAGE_LIMIT,
  openCodeMessageReadFailureReason,
  OpenCodeSessionFlights,
  reconcileOpenCodeIdle,
  type IdleContinuationDependencies,
} from './idle.js';
import { OpenCodeIdleState } from './idle-state.js';
import { parseOpenCodePluginOptions } from './runtime-invocation.js';
import { OpenCodeCompactionState } from './compaction.js';
import { OpenCodePluginLifecycle } from './lifecycle.js';
import { runKiokukoCompactionHook } from './hook-effect.js';
import { canonicalContentHash } from '../serialization/validate.js';
import { createExecutionHooks } from './execution.js';

const MAX_PROCESSED_COMPACTIONS = 512;
const MAX_COMPACTION_SUMMARY_CHARS = 64 * 1024;

export type OpenCodeCompactionSummaryExtraction =
  | { ok: true; summaryMessageId: string; summaryText: string }
  | {
    ok: false;
    reason: 'summary_message_missing' | 'summary_text_parts_missing' | 'summary_text_empty' | 'summary_text_too_large';
    retryable: boolean;
  };

/** Extract the newest usable OpenCode compaction summary without mutating the response. */
export function extractOpenCodeCompactionSummary(messages: unknown): OpenCodeCompactionSummaryExtraction {
  if (!Array.isArray(messages)) {
    return { ok: false, reason: 'summary_message_missing', retryable: true };
  }
  const summary = [...messages].reverse().find((message) => {
    const info = typeof message === 'object' && message !== null && 'info' in message
      ? (message as { info?: unknown }).info
      : undefined;
    return typeof info === 'object' && info !== null && (info as { summary?: unknown }).summary === true;
  }) as { info?: { id?: unknown }; parts?: unknown } | undefined;
  if (summary === undefined || typeof summary.info?.id !== 'string') {
    return { ok: false, reason: 'summary_message_missing', retryable: true };
  }
  if (!Array.isArray(summary.parts)) {
    return { ok: false, reason: 'summary_text_parts_missing', retryable: true };
  }
  const textParts = summary.parts.flatMap((part) => {
    if (typeof part !== 'object' || part === null) return [];
    const value = part as { type?: unknown; text?: unknown };
    return value.type === 'text' && typeof value.text === 'string' ? [value.text] : [];
  });
  if (textParts.length === 0) {
    return { ok: false, reason: 'summary_text_parts_missing', retryable: false };
  }
  const summaryText = textParts.join('\n').trim();
  if (summaryText.length === 0) {
    return { ok: false, reason: 'summary_text_empty', retryable: false };
  }
  if (summaryText.length > MAX_COMPACTION_SUMMARY_CHARS) {
    return { ok: false, reason: 'summary_text_too_large', retryable: false };
  }
  return { ok: true, summaryMessageId: summary.info.id, summaryText };
}

/**
 * OpenCode's plugin entrypoint.
 *
 * Keep this boundary thin: OpenCode owns the injected SDK client and event
 * lifecycle; Kiokuko only supplies bounded policy/effect adapters.
 */
export const KiokukoPlugin: Plugin = async ({ client, directory }, options) => {
  const runtime = options === undefined ? undefined : parseOpenCodePluginOptions(options);
  const state = new OpenCodeIdleState();
  const compactionState = new OpenCodeCompactionState();
  const flights = new OpenCodeSessionFlights();
  const lifecycle = new OpenCodePluginLifecycle();
  const compactionFlights = new Map<string, Promise<void>>();
  const processedCompactions = new Map<string, string>();
  const reconciliationState = { sessionUpdates: new Map<string, number>(), retrySessionIds: new Set<string>() };
  const idleDependencies: IdleContinuationDependencies = {
    state,
    flights,
    reconciliationState,
    signal: lifecycle.signal,
    active: () => lifecycle.isActive(),
    ...(options === undefined ? {} : runtime === undefined
      ? { runtimeFailure: 'version_mismatch' as const }
      : { runtime }),
    log: async (message, extra) => {
      await client.app.log({
        body: { service: 'kiokuko', level: 'warn', message, ...(extra === undefined ? {} : { extra }) },
        query: { directory },
      });
    },
  };
  const handleEvent = createOpenCodeIdleHandler(client, directory, idleDependencies);
  const compactionHookDependencies = {
    signal: lifecycle.signal,
    timeoutMs: 1_500,
    ...(options === undefined ? {} : runtime === undefined
      ? { runtimeFailure: 'version_mismatch' as const }
      : { runtime }),
  };
  const execution = createExecutionHooks(client, directory, options, { ...compactionHookDependencies, timeoutMs: 10_000 });
  const logCompactionWarning = async (message: string, reason: string): Promise<void> => {
    try {
      await idleDependencies.log?.(message, { reason });
    } catch {
      // Logging must not create another lifecycle failure.
    }
  };
  const postCompaction = (sessionId: string): void => {
    if (!lifecycle.isActive() || compactionFlights.has(sessionId)) return;
    const operation = lifecycle.run(async () => {
      try {
        let pendingExtractionFailure: Exclude<OpenCodeCompactionSummaryExtraction, { ok: true }> | undefined;
        for (let attempt = 0; attempt < 3 && lifecycle.isActive(); attempt += 1) {
          if (attempt > 0) await new Promise<void>((resolve) => setTimeout(resolve, attempt * 50));
          const signal = AbortSignal.any([lifecycle.signal, AbortSignal.timeout(KIOKUKO_OPENCODE_API_TIMEOUT_MS)]);
          let response: unknown;
          try {
            response = await client.session.messages({
              path: { id: sessionId },
              query: { limit: KIOKUKO_OPENCODE_MESSAGE_LIMIT },
              signal,
            });
          } catch (error) {
            if (lifecycle.signal.aborted) return;
            await logCompactionWarning(
              'OpenCode compaction messages read failed',
              openCodeMessageReadFailureReason(error, signal),
            );
            return;
          }
          if (!lifecycle.isActive()) return;
          const messages = typeof response === 'object' && response !== null && 'data' in response
            ? (response as { data?: unknown }).data
            : response;
          const extraction = extractOpenCodeCompactionSummary(messages);
          if (!extraction.ok) {
            pendingExtractionFailure = extraction;
            if (extraction.retryable) continue;
            await logCompactionWarning('OpenCode compaction summary unavailable', extraction.reason);
            return;
          }
          if (processedCompactions.get(sessionId) === extraction.summaryMessageId) {
            await logCompactionWarning('OpenCode compaction post already processed', 'already_processed');
            return;
          }
          const boundary = compactionState.boundary(sessionId);
          const accepted = await runKiokukoCompactionHook({
            phase: 'after',
            sessionId,
            cwd: directory,
            runId: boundary?.runId ?? null,
            summaryMessageId: extraction.summaryMessageId,
            summaryText: extraction.summaryText,
            summaryDigest: canonicalContentHash(extraction.summaryText),
          }, compactionHookDependencies);
          if (accepted) {
            processedCompactions.delete(sessionId);
            processedCompactions.set(sessionId, extraction.summaryMessageId);
            if (processedCompactions.size > MAX_PROCESSED_COMPACTIONS) {
              const oldestSessionId = processedCompactions.keys().next().value;
              if (oldestSessionId !== undefined) processedCompactions.delete(oldestSessionId);
            }
          }
          return;
        }
        if (pendingExtractionFailure !== undefined && lifecycle.isActive()) {
          await logCompactionWarning('OpenCode compaction summary unavailable', pendingExtractionFailure.reason);
        }
      } catch (error) {
        if (!lifecycle.signal.aborted) {
          await logCompactionWarning('OpenCode compaction meditation enqueue failed', 'compaction_post_failed');
        }
      }
    });
    compactionFlights.set(sessionId, operation);
    void operation.finally(() => compactionFlights.delete(sessionId)).catch(() => undefined);
  };
  const event = (input: { event: unknown }) => {
    const value = typeof input.event === 'object' && input.event !== null
      ? input.event as { type?: unknown; properties?: { sessionID?: unknown } }
      : undefined;
    if (value?.type === 'session.compacted' && typeof value.properties?.sessionID === 'string') {
      postCompaction(value.properties.sessionID);
    }
    return lifecycle.run(async () => {
      try { await execution.event!({ event: input.event as never }); } catch { await logCompactionWarning('Execution failure record unavailable', 'execution_record_failed'); }
      await handleEvent(input);
    });
  };
  const reconcile = () => lifecycle.reconcile(async () => {
    try {
      await reconcileOpenCodeIdle(client, directory, idleDependencies);
    } catch (error) {
      if (lifecycle.signal.aborted) return;
      throw error;
    }
  });
  const reportReconcileFailure = async (): Promise<void> => {
    try {
      await client.app.log({
        body: { service: 'kiokuko', level: 'warn', message: 'OpenCode reconciliation failed', extra: { reason: 'reconciliation_error' } },
        query: { directory },
      });
    } catch {
      // Logging must not create another lifecycle failure.
    }
  };
  const timer = setInterval(() => {
    void reconcile().catch(reportReconcileFailure);
  }, 1_000);
  timer.unref?.();
  void reconcile().catch(reportReconcileFailure);
  return {
    event,
    config: execution.config!,
    'tool.execute.before': execution['tool.execute.before']!,
    'tool.execute.after': async (input, output) => {
      if (!lifecycle.isActive()) return;
      const { tool, sessionID } = input;
      await execution['tool.execute.after']!(input, output);
      compactionState.observe(sessionID, tool, output);
    },
    'experimental.session.compacting': async ({ sessionID }, output) => {
      if (!lifecycle.isActive()) return;
      compactionState.appendContext(sessionID, output.context);
      const boundary = compactionState.boundary(sessionID);
      if (boundary !== null) {
        await runKiokukoCompactionHook({
          phase: 'before',
          sessionId: sessionID,
          cwd: directory,
          boundary,
        }, compactionHookDependencies);
      }
    },
    'experimental.compaction.autocontinue': async ({ sessionID }) => {
      if (lifecycle.isActive()) postCompaction(sessionID);
    },
    dispose: () => lifecycle.dispose(() => clearInterval(timer)),
  };
};

export default KiokukoPlugin;
