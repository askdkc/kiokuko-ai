export const MAX_IDLE_ENTRIES = 512;
export const MAX_IDLE_RETRIES = 3;

export type IdleEntry =
  | { state: 'in_flight'; hookAttempts: number }
  | { state: 'retryable_failure'; hookAttempts: number; reason: string }
  | { state: 'pending_prompt'; messageId: string; text: string; deliveryAttempts: number }
  | { state: 'prompt_in_flight'; messageId: string; text: string; deliveryAttempts: number }
  | { state: 'completed'; outcome: 'continued' | 'stopped' | 'reconciled' }
  | { state: 'quarantined'; reason: string };

export type IdleBeginResult =
  | { kind: 'run_hook'; hookAttempts: number }
  | { kind: 'send_pending' }
  | { kind: 'ignored' }
  | { kind: 'capacity_exceeded' };

export interface PromptClaim {
  readonly messageId: string;
  readonly text: string;
  readonly deliveryAttempts: number;
}

/** Own one OpenCode plugin instance's lifecycle state and compare-and-set transitions. */
export class OpenCodeIdleState {
  private readonly entries = new Map<string, IdleEntry>();

  begin(key: string): IdleBeginResult {
    const existing = this.entries.get(key);
    if (existing?.state === 'in_flight' || existing?.state === 'prompt_in_flight') return { kind: 'ignored' };
    if (existing?.state === 'pending_prompt') {
      if (existing.deliveryAttempts >= MAX_IDLE_RETRIES) {
        this.entries.set(key, { state: 'quarantined', reason: 'prompt_retry_exhausted' });
        return { kind: 'ignored' };
      }
      return { kind: 'send_pending' };
    }
    if (existing?.state === 'completed' || existing?.state === 'quarantined') return { kind: 'ignored' };

    const hookAttempts = existing?.state === 'retryable_failure' ? existing.hookAttempts + 1 : 1;
    if (existing === undefined && !this.reserveEntry()) return { kind: 'capacity_exceeded' };
    this.entries.set(key, { state: 'in_flight', hookAttempts });
    return { kind: 'run_hook', hookAttempts };
  }

  markHookFailure(key: string, hookAttempts: number, reason: string): boolean {
    const current = this.entries.get(key);
    if (current?.state !== 'in_flight' || current.hookAttempts !== hookAttempts) return false;
    if (hookAttempts >= MAX_IDLE_RETRIES) {
      this.entries.set(key, { state: 'quarantined', reason: 'retry_exhausted' });
      return true;
    }
    this.entries.set(key, { state: 'retryable_failure', hookAttempts, reason });
    return true;
  }

  markPendingPrompt(key: string, hookAttempts: number, messageId: string, text: string): boolean {
    const current = this.entries.get(key);
    if (current?.state !== 'in_flight' || current.hookAttempts !== hookAttempts) return false;
    this.entries.set(key, { state: 'pending_prompt', messageId, text, deliveryAttempts: 0 });
    return true;
  }

  claimPrompt(key: string): PromptClaim | undefined {
    const current = this.entries.get(key);
    if (current?.state !== 'pending_prompt' || current.deliveryAttempts >= MAX_IDLE_RETRIES) return undefined;
    const claim: PromptClaim = {
      messageId: current.messageId,
      text: current.text,
      deliveryAttempts: current.deliveryAttempts,
    };
    this.entries.set(key, { ...current, state: 'prompt_in_flight' });
    return claim;
  }

  markPromptAttempt(key: string, claim: PromptClaim): PromptClaim | undefined {
    const current = this.entries.get(key);
    if (current?.state !== 'prompt_in_flight' || current.messageId !== claim.messageId
      || current.deliveryAttempts !== claim.deliveryAttempts) return undefined;
    const attempted = { ...claim, deliveryAttempts: claim.deliveryAttempts + 1 };
    this.entries.set(key, { state: 'prompt_in_flight', ...attempted });
    return attempted;
  }

  markPromptUnconfirmed(key: string, claim: PromptClaim): boolean {
    const current = this.entries.get(key);
    if (current?.state !== 'prompt_in_flight' || current.messageId !== claim.messageId
      || current.deliveryAttempts !== claim.deliveryAttempts) return false;
    if (claim.deliveryAttempts >= MAX_IDLE_RETRIES) {
      this.entries.set(key, { state: 'quarantined', reason: 'prompt_retry_exhausted' });
      return true;
    }
    this.entries.set(key, { state: 'pending_prompt', ...claim });
    return true;
  }

  markCompleted(
    key: string,
    outcome: Extract<IdleEntry, { state: 'completed' }>['outcome'],
    expected?: { state: 'in_flight'; hookAttempts: number } | { state: 'prompt_in_flight'; messageId: string },
  ): boolean {
    const current = this.entries.get(key);
    if (expected?.state === 'in_flight'
      && (current?.state !== 'in_flight' || current.hookAttempts !== expected.hookAttempts)) return false;
    if (expected?.state === 'prompt_in_flight'
      && (current?.state !== 'prompt_in_flight' || current.messageId !== expected.messageId)) return false;
    if (expected === undefined && current?.state === 'completed') return true;
    this.entries.set(key, { state: 'completed', outcome });
    return true;
  }

  markHookQuarantined(key: string, hookAttempts: number, reason: string): boolean {
    const current = this.entries.get(key);
    if (current?.state !== 'in_flight' || current.hookAttempts !== hookAttempts) return false;
    this.entries.set(key, { state: 'quarantined', reason });
    return true;
  }

  get(key: string): IdleEntry | undefined {
    return this.entries.get(key);
  }

  /** Release only the exact provisional hook claim proved stale by the host. */
  release(key: string, hookAttempts: number): boolean {
    const current = this.entries.get(key);
    if (current?.state !== 'in_flight' || current.hookAttempts !== hookAttempts) return false;
    this.entries.delete(key);
    return true;
  }

  private reserveEntry(): boolean {
    if (this.entries.size < MAX_IDLE_ENTRIES) return true;
    for (const [key, entry] of this.entries) {
      if (entry.state === 'completed' || entry.state === 'quarantined') {
        this.entries.delete(key);
        if (this.entries.size < MAX_IDLE_ENTRIES) return true;
      }
    }
    return false;
  }
}
