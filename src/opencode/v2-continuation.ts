import { createHash } from 'node:crypto';
import type { Plugin } from '@opencode/plugin';
import { canonicalContentHash } from '../serialization/validate.js';
import { runKiokukoHook, readKiokukoContinuationReceipt, readKiokukoTrackedSessions, type HookDecision, type HookEffectDependencies, type HookEffectInput } from './hook-effect.js';
import { readContextBoundary, readSessionSnapshot, validateSessionBinding } from './v2-adapter.js';
import type { ContinuationReceipt, TrackedOpenCodeSession } from './tracking.js';

type Context = Plugin.Context;
type Phase = 'hook_pending' | 'prompt_pending' | 'sending' | 'accepted' | 'stopped' | 'quarantined';
interface Outbox {
  phase: Phase;
  terminalMessageId: string;
  latestInputId: string;
  runId: string;
  workspace: string;
  orchestrationId: string;
  sessionId: string;
  directory: string;
  revision: number;
  mutationRevision: number;
  routeEpoch: number;
  hookAttempts: number;
  deliveryAttempts: number;
  messageId?: string;
  text?: string;
  textDigest?: string;
  directiveDigest?: string;
  receiptAttempts?: number;
  reason?: string;
}
export interface ContinuationOperations {
  tracked(directory: string, dependencies: HookEffectDependencies): Promise<TrackedOpenCodeSession[]>;
  receipt(input: { directory: string; runId: string; sessionId: string; terminalMessageId: string }, dependencies: HookEffectDependencies): Promise<ContinuationReceipt | null>;
  hook(input: HookEffectInput, dependencies: HookEffectDependencies): Promise<HookDecision>;
}
const defaultOperations: ContinuationOperations = {
  tracked: readKiokukoTrackedSessions,
  receipt: readKiokukoContinuationReceipt,
  hook: runKiokukoHook,
};

function promptMessageId(directory: string, sessionId: string, terminalMessageId: string): string {
  const digest = createHash('sha256')
    .update('kiokuko-opencode-prompt-v1\0', 'utf8')
    .update(directory, 'utf8').update('\0', 'utf8')
    .update(sessionId, 'utf8').update('\0', 'utf8')
    .update(terminalMessageId, 'utf8').digest('hex').slice(0, 32);
  return `msg_kiokuko_${digest}`;
}

function storageKey(binding: TrackedOpenCodeSession, terminalMessageId: string): string {
  return `continuation/${canonicalContentHash([
    binding.repositoryRoot, binding.workspace, binding.runId, binding.sessionId, terminalMessageId,
  ])}`;
}

function storedOutbox(value: unknown): Outbox | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const item = value as Record<string, unknown>;
  if (!['hook_pending', 'prompt_pending', 'sending', 'accepted', 'stopped', 'quarantined'].includes(String(item.phase))) return null;
  if (['terminalMessageId', 'latestInputId', 'runId', 'workspace', 'orchestrationId', 'sessionId', 'directory'].some(key => typeof item[key] !== 'string')) return null;
  if (['revision', 'mutationRevision', 'routeEpoch', 'hookAttempts', 'deliveryAttempts'].some(key => !Number.isSafeInteger(item[key]) || Number(item[key]) < 0)) return null;
  if (['messageId', 'text', 'textDigest', 'directiveDigest', 'reason'].some(key => item[key] !== undefined && typeof item[key] !== 'string')) return null;
  if (item.receiptAttempts !== undefined && (!Number.isSafeInteger(item.receiptAttempts) || Number(item.receiptAttempts) < 0)) return null;
  if ((item.phase === 'prompt_pending' || item.phase === 'sending' || item.phase === 'accepted')
    && (typeof item.messageId !== 'string' || typeof item.text !== 'string' || typeof item.textDigest !== 'string')) return null;
  return item as unknown as Outbox;
}

function sameBinding(outbox: Outbox, binding: TrackedOpenCodeSession): boolean {
  return outbox.runId === binding.runId && outbox.workspace === binding.workspace
    && outbox.orchestrationId === binding.orchestrationId
    && outbox.sessionId === binding.sessionId && outbox.directory === binding.repositoryRoot
    && outbox.revision === binding.revision && outbox.mutationRevision === binding.mutationRevision
    && outbox.routeEpoch === binding.routeEpoch;
}

function receiptMatches(outbox: Outbox, receipt: ContinuationReceipt | null): boolean {
  return receipt !== null && receipt.contractRevision === outbox.revision
    && receipt.mutationRevision === outbox.mutationRevision
    && receipt.routeEpoch === outbox.routeEpoch
    && (outbox.directiveDigest === undefined || outbox.directiveDigest === receipt.directiveDigest)
    && (outbox.receiptAttempts === undefined || outbox.receiptAttempts === receipt.attempts);
}

/** Durable, fail-closed continuation admission for the V2 plugin. */
export class OpenCodeV2Continuation {
  private readonly flights = new Map<string, Promise<void>>();
  private readonly localSending = new Set<string>();
  constructor(
    private readonly ctx: Context,
    private readonly directory: string,
    private readonly projectID: string,
    private readonly dependencies: HookEffectDependencies,
    private readonly active: () => boolean,
    private readonly warn: (reason: string) => void,
    private readonly operations: ContinuationOperations = defaultOperations,
  ) {}

  private async save(key: string, outbox: Outbox): Promise<void> {
    if (!this.active()) return;
    await this.ctx.storage.set(key, JSON.parse(JSON.stringify(outbox)));
  }

  private async freshBinding(sessionId: string): Promise<TrackedOpenCodeSession | undefined> {
    const bindings = await this.operations.tracked(this.directory, this.dependencies);
    return bindings.find(item => item.sessionId === sessionId && item.repositoryRoot === this.directory);
  }

  private async quarantine(key: string, outbox: Outbox, reason: string): Promise<void> {
    await this.save(key, { ...outbox, phase: 'quarantined', reason });
    this.warn(reason);
  }

  private async reconcileSaved(binding: TrackedOpenCodeSession, key: string, outbox: Outbox): Promise<void> {
    if (!this.active() || outbox.phase === 'accepted' || outbox.phase === 'stopped' || outbox.phase === 'quarantined') return;
    if (!sameBinding(outbox, binding)) { await this.quarantine(key, outbox, 'stale_run_binding'); return; }
    const snapshot = await readSessionSnapshot(this.ctx.session, binding.sessionId);
    if (!validateSessionBinding(snapshot, binding, this.directory, this.projectID)) {
      await this.quarantine(key, outbox, 'session_identity_mismatch'); return;
    }
    const messages = await this.ctx.session.context({ sessionID: binding.sessionId });
    if (outbox.phase === 'sending') {
      const message = messages.find(item => item.id === outbox.messageId);
      if (message?.type === 'user' && canonicalContentHash(message.text) === outbox.textDigest) {
        await this.save(key, { ...outbox, phase: 'accepted' });
      } else await this.quarantine(key, outbox, message ? 'prompt_content_mismatch' : 'prompt_admission_unknown');
      return;
    }
    const boundary = await readContextBoundary(this.ctx.session, binding.sessionId);
    if (!boundary || boundary.terminalMessageId !== outbox.terminalMessageId || boundary.latestInputId !== outbox.latestInputId) {
      await this.quarantine(key, outbox, 'continuation_boundary_changed'); return;
    }
    await this.run(binding.sessionId, false);
  }

  private async reconcileOne(binding: TrackedOpenCodeSession, allowNewHook: boolean): Promise<void> {
    if (!this.active()) return;
    const snapshot = await readSessionSnapshot(this.ctx.session, binding.sessionId);
    if (!validateSessionBinding(snapshot, binding, this.directory, this.projectID)) {
      this.warn('session_identity_mismatch');
      return;
    }
    const boundary = await readContextBoundary(this.ctx.session, binding.sessionId);
    if (!boundary || snapshot.outcome !== 'succeeded') return;
    const key = storageKey(binding, boundary.terminalMessageId);
    let outbox = storedOutbox(await this.ctx.storage.get(key));
    if (!outbox) {
      if (!allowNewHook) return;
      outbox = {
        phase: 'hook_pending', terminalMessageId: boundary.terminalMessageId,
        latestInputId: boundary.latestInputId, runId: binding.runId,
        workspace: binding.workspace, orchestrationId: binding.orchestrationId,
        sessionId: binding.sessionId, directory: this.directory,
        revision: binding.revision, mutationRevision: binding.mutationRevision,
        routeEpoch: binding.routeEpoch, hookAttempts: 0, deliveryAttempts: 0,
      };
      await this.save(key, outbox);
    }
    if (!sameBinding(outbox, binding)) {
      await this.quarantine(key, outbox, 'stale_run_binding');
      return;
    }
    if (outbox.phase === 'accepted' || outbox.phase === 'stopped' || outbox.phase === 'quarantined') return;
    if (outbox.latestInputId !== boundary.latestInputId) {
      await this.quarantine(key, outbox, 'new_user_input');
      return;
    }
    if (outbox.phase === 'sending') {
      const found = boundary.messages.find(message => message.id === outbox!.messageId);
      if (found?.type === 'user' && canonicalContentHash(found.text) === outbox.textDigest) {
        await this.save(key, { ...outbox, phase: 'accepted' });
      } else await this.quarantine(key, outbox, found ? 'prompt_content_mismatch' : 'prompt_admission_unknown');
      return;
    }
    if (outbox.phase === 'hook_pending') {
      if (outbox.hookAttempts >= 3) {
        await this.quarantine(key, outbox, 'hook_retry_exhausted');
        return;
      }
      const current = await this.freshBinding(binding.sessionId);
      if (!current || !sameBinding(outbox, current)) {
        await this.quarantine(key, outbox, 'stale_run_binding');
        return;
      }
      outbox = { ...outbox, hookAttempts: outbox.hookAttempts + 1 };
      await this.save(key, outbox);
      const decision = await this.operations.hook({ sessionId: binding.sessionId, terminalMessageId: boundary.terminalMessageId, cwd: this.directory }, this.dependencies);
      if (!this.active()) return;
      if (decision.kind === 'stop') {
        await this.save(key, { ...outbox, phase: 'stopped', reason: decision.reason });
        return;
      }
      if (decision.kind === 'failure') {
        if (!decision.retryable || outbox.hookAttempts >= 3) await this.quarantine(key, outbox, decision.reason);
        else this.warn(decision.reason);
        return;
      }
      const receipt = await this.operations.receipt({ directory: this.directory, runId: binding.runId, sessionId: binding.sessionId, terminalMessageId: boundary.terminalMessageId }, this.dependencies);
      if (!receiptMatches(outbox, receipt)) {
        await this.quarantine(key, outbox, 'continuation_receipt_mismatch');
        return;
      }
      outbox = { ...outbox, phase: 'prompt_pending', messageId: promptMessageId(this.directory, binding.sessionId, boundary.terminalMessageId),
        text: decision.text, textDigest: canonicalContentHash(decision.text), directiveDigest: receipt!.directiveDigest, receiptAttempts: receipt!.attempts };
      await this.save(key, outbox);
    }
    if (outbox.phase !== 'prompt_pending' || !outbox.messageId || !outbox.text) return;
    if (outbox.deliveryAttempts > 0) {
      await this.quarantine(key, outbox, 'prompt_admission_unknown');
      return;
    }
    const current = await this.freshBinding(binding.sessionId);
    const receipt = await this.operations.receipt({ directory: this.directory, runId: binding.runId, sessionId: binding.sessionId, terminalMessageId: boundary.terminalMessageId }, this.dependencies);
    if (!current || !sameBinding(outbox, current) || !receiptMatches(outbox, receipt)
      || canonicalContentHash(outbox.text) !== outbox.textDigest) {
      await this.quarantine(key, outbox, 'continuation_preflight_failed');
      return;
    }
    const latest = await readContextBoundary(this.ctx.session, binding.sessionId);
    if (!latest || latest.terminalMessageId !== outbox.terminalMessageId || latest.latestInputId !== outbox.latestInputId) {
      await this.quarantine(key, outbox, 'new_user_input');
      return;
    }
    outbox = { ...outbox, phase: 'sending', deliveryAttempts: 1 };
    await this.save(key, outbox);
    this.localSending.add(key);
    try {
      await this.ctx.session.prompt({ sessionID: binding.sessionId, id: outbox.messageId, text: outbox.text! });
      if (this.active()) await this.save(key, { ...outbox, phase: 'accepted' });
    } catch {
      if (this.active()) await this.quarantine(key, outbox, 'prompt_admission_unknown');
    } finally {
      this.localSending.delete(key);
    }
  }

  run(sessionId: string, allowNewHook: boolean): Promise<void> {
    const predecessor = this.flights.get(sessionId) ?? Promise.resolve();
    const current = predecessor.catch(() => undefined).then(async () => {
      const binding = await this.freshBinding(sessionId);
      if (binding && this.active()) await this.reconcileOne(binding, allowNewHook);
    }).catch(() => this.warn('continuation_reconciliation_failed')).finally(() => {
      if (this.flights.get(sessionId) === current) this.flights.delete(sessionId);
    });
    this.flights.set(sessionId, current);
    return current;
  }

  async reconcileTracked(): Promise<void> {
    const bindings = await this.operations.tracked(this.directory, this.dependencies);
    const bySession = new Map(bindings.map(binding => [binding.sessionId, binding]));
    let after: string | undefined;
    for (let page = 0; page < 100 && this.active(); page++) {
      const scanned = await this.ctx.storage.scan({ prefix: 'continuation/', ...(after ? { after } : {}), limit: 100 });
      for (const entry of scanned.entries) {
        if (this.localSending.has(entry.key)) continue;
        const outbox = storedOutbox(entry.value);
        if (!outbox || outbox.directory !== this.directory) continue;
        const binding = bySession.get(outbox.sessionId);
        if (binding) await this.reconcileSaved(binding, entry.key, outbox);
        else if (!['accepted', 'stopped', 'quarantined'].includes(outbox.phase)) await this.quarantine(entry.key, outbox, 'run_no_longer_tracked');
      }
      if (!scanned.next) break;
      after = scanned.next;
      if (page === 99) this.warn('continuation_storage_scan_limit');
    }
    await Promise.all(bindings.map(binding => this.run(binding.sessionId, false)));
  }
}
