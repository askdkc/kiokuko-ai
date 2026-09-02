import type { RunStatus } from './types.js';

export type CheckpointIneligibility =
  | {
      allowed: false;
      reason: 'run_awaiting_intake_answer';
      nextAction: 'answer_from_evidence_or_ask_user';
      retryableAfterStateChange: true;
    }
  | {
      allowed: false;
      reason: 'run_terminal';
      nextAction: 'stop';
      retryableAfterStateChange: false;
    };

export type CheckpointEligibility = { allowed: true } | CheckpointIneligibility;

export function checkpointEligibility(status: RunStatus): CheckpointEligibility {
  if (status === 'active') return { allowed: true };
  if (status === 'intake') {
    return {
      allowed: false,
      reason: 'run_awaiting_intake_answer',
      nextAction: 'answer_from_evidence_or_ask_user',
      retryableAfterStateChange: true,
    };
  }
  return {
    allowed: false,
    reason: 'run_terminal',
    nextAction: 'stop',
    retryableAfterStateChange: false,
  };
}
