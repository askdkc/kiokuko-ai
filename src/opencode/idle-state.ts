export const MAX_IDLE_ENTRIES = 512;
export const MAX_IDLE_RETRIES = 3;

export type IdleEntry =
  | { state: 'in_flight'; attempts: number }
  | { state: 'retryable_failure'; attempts: number; reason: string }
  | { state: 'pending_prompt'; messageId: string; text: string; promptAttempts: number }
  | { state: 'completed'; outcome: 'continued' | 'stopped' | 'reconciled' }
  | { state: 'quarantined'; reason: string };

export type IdleBeginResult =
  | { kind: 'run_hook'; attempts: number }
  | { kind: 'send_pending'; entry: Extract<IdleEntry, { state: 'pending_prompt' }> }
  | { kind: 'ignored' }
  | { kind: 'capacity_exceeded' };

/** Own one OpenCode plugin instance's lifecycle state and bounded replay policy. */
export class OpenCodeIdleState {
  private readonly entries = new Map<string, IdleEntry>();

  begin(key: string): IdleBeginResult {
    const existing = this.entries.get(key);
    if (existing?.state === 'in_flight') return { kind: 'ignored' };
    if (existing?.state === 'pending_prompt') {
      if (existing.promptAttempts >= MAX_IDLE_RETRIES) {
        this.entries.set(key, { state: 'quarantined', reason: 'prompt_retry_exhausted' });
        return { kind: 'ignored' };
      }
      return { kind: 'send_pending', entry: existing };
    }
    if (existing?.state === 'completed' || existing?.state === 'quarantined') return { kind: 'ignored' };

    const attempts = existing?.state === 'retryable_failure' ? existing.attempts + 1 : 1;
    if (existing === undefined && !this.reserveEntry()) return { kind: 'capacity_exceeded' };
    this.entries.set(key, { state: 'in_flight', attempts });
    return { kind: 'run_hook', attempts };
  }

  markRetryableFailure(key: string, attempts: number, reason: string): void {
    if (attempts >= MAX_IDLE_RETRIES) {
      this.entries.set(key, { state: 'quarantined', reason: 'retry_exhausted' });
      return;
    }
    this.entries.set(key, { state: 'retryable_failure', attempts, reason });
  }

  markPendingPrompt(key: string, messageId: string, text: string): void {
    const current = this.entries.get(key);
    const promptAttempts = current?.state === 'pending_prompt' ? current.promptAttempts : 0;
    this.entries.set(key, { state: 'pending_prompt', messageId, text, promptAttempts });
  }

  markPromptAttempt(key: string): Extract<IdleEntry, { state: 'pending_prompt' }> | undefined {
    const current = this.entries.get(key);
    if (current?.state !== 'pending_prompt') return undefined;
    const updated = { ...current, promptAttempts: current.promptAttempts + 1 };
    this.entries.set(key, updated);
    return updated;
  }

  markCompleted(key: string, outcome: Extract<IdleEntry, { state: 'completed' }>['outcome']): void {
    this.entries.set(key, { state: 'completed', outcome });
  }

  markQuarantined(key: string, reason: string): void {
    this.entries.set(key, { state: 'quarantined', reason });
  }

  get(key: string): IdleEntry | undefined {
    return this.entries.get(key);
  }

  /** Release a provisional claim when the host proves that the event is stale or a child session. */
  release(key: string): void {
    if (this.entries.get(key)?.state === 'in_flight') this.entries.delete(key);
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
