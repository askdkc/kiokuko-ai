import { KiokukoError } from '../errors.js';

export const PLAN_START_RECOVERY_CODE = 'PLAN_START_RECOVERY_REQUIRED' as const;
export const PLAN_START_RECOVERY_DETAIL_KEY = 'planStartRecoveryReason' as const;
export const PLAN_START_RECOVERY_REASONS = [
  'environment_information_missing',
  'environment_changed',
  'previous_attempt_ended',
] as const;

export type PlanStartRecoveryReason = (typeof PLAN_START_RECOVERY_REASONS)[number];
export const PLAN_START_RECOVERY_BLOCKER_PREFIX = 'plan_start_recovery:';

export function planStartRecoveryBlocker(reason: PlanStartRecoveryReason): string {
  return `${PLAN_START_RECOVERY_BLOCKER_PREFIX}${reason}`;
}

export function planStartRecoveryReasonFromBlocker(value: string | null): PlanStartRecoveryReason | null {
  if (value?.startsWith(PLAN_START_RECOVERY_BLOCKER_PREFIX) !== true) return null;
  const reason = value.slice(PLAN_START_RECOVERY_BLOCKER_PREFIX.length);
  return PLAN_START_RECOVERY_REASONS.includes(reason as PlanStartRecoveryReason)
    ? reason as PlanStartRecoveryReason
    : null;
}

export type PlanStartRecoveryAction =
  | 'continue_same_plan'
  | 'revise_plan'
  | 'restart_same_plan'
  | 'revise_then_restart'
  | 'cancel';

export interface UserFacingPlanRecoveryOption {
  action: PlanStartRecoveryAction;
  label: string;
  recommended: boolean;
  whenToChoose: string;
  whatHappens: string;
}

export interface UserFacingPlanRecovery {
  presentationVersion: 1;
  whatHappened: string;
  workState: string;
  resolution: string;
  options: UserFacingPlanRecoveryOption[];
}

export interface PlanStartRecovery {
  code: typeof PLAN_START_RECOVERY_CODE;
  reason: PlanStartRecoveryReason;
  userFacingRecovery: UserFacingPlanRecovery;
  effect: {
    mutationApplied: false;
    continuationPaused: true;
    planPersisted: false;
    advisoryConsumed: false;
    operationReceiptCreated: false;
    implementationStarted: false;
  };
  retry: { sameRunAllowed: boolean; requiresUserChoice: true };
}

const RECOVERY_EFFECT = {
  mutationApplied: false,
  continuationPaused: true,
  planPersisted: false,
  advisoryConsumed: false,
  operationReceiptCreated: false,
  implementationStarted: false,
} as const;

const NO_NEW_WORK = 'Starting this plan did not begin new work or make additional code changes.';

export function buildPlanStartRecovery(reason: PlanStartRecoveryReason): PlanStartRecovery {
  if (reason === 'environment_information_missing') {
    return {
      code: PLAN_START_RECOVERY_CODE,
      reason,
      effect: RECOVERY_EFFECT,
      retry: { sameRunAllowed: true, requiresUserChoice: true },
      userFacingRecovery: {
        presentationVersion: 1,
        whatHappened: 'Information about the features available in this environment was not carried into the plan.',
        workState: NO_NEW_WORK,
        resolution: 'Attach the current environment information to continue with the same plan.',
        options: [
          {
            action: 'continue_same_plan',
            label: 'Continue with the same plan',
            recommended: true,
            whenToChoose: 'The plan is still correct and only the current environment information needs to be attached.',
            whatHappens: 'The current environment information is attached automatically, and the same attempt continues.',
          },
          {
            action: 'revise_plan',
            label: 'Review the plan',
            recommended: false,
            whenToChoose: 'You want to change the scope, work items, or verification before continuing.',
            whatHappens: 'You are asked what to change, and implementation does not start until you answer.',
          },
          {
            action: 'cancel',
            label: 'Cancel',
            recommended: false,
            whenToChoose: 'You no longer want this work to continue.',
            whatHappens: 'The current attempt is cancelled, and no replacement attempt is created.',
          },
        ],
      },
    };
  }
  if (reason === 'previous_attempt_ended') {
    return {
      code: PLAN_START_RECOVERY_CODE,
      reason,
      effect: RECOVERY_EFFECT,
      retry: { sameRunAllowed: false, requiresUserChoice: true },
      userFacingRecovery: {
        presentationVersion: 1,
        whatHappened: 'Required environment information was not included when this plan was submitted, so this attempt has ended.',
        workState: NO_NEW_WORK,
        resolution: 'The plan itself can be used to start a new attempt with the current environment.',
        options: [
          {
            action: 'restart_same_plan',
            label: 'Restart with the same plan',
            recommended: true,
            whenToChoose: 'The ended attempt\'s plan is still correct and should be reused.',
            whatHappens: 'The ended attempt stays unchanged, and a new attempt starts with the current environment and the same agreed plan.',
          },
          {
            action: 'revise_then_restart',
            label: 'Review the plan before restarting',
            recommended: false,
            whenToChoose: 'You want to change the scope, work items, or verification before creating a replacement.',
            whatHappens: 'You are asked what to change; the ended attempt stays unchanged, and a new attempt starts with the current environment and revised plan only after you answer.',
          },
          {
            action: 'cancel',
            label: 'Cancel',
            recommended: false,
            whenToChoose: 'You do not want to restart the work.',
            whatHappens: 'The ended attempt remains ended, and no new attempt is created.',
          },
        ],
      },
    };
  }
  return {
    code: PLAN_START_RECOVERY_CODE,
    reason,
    effect: RECOVERY_EFFECT,
    retry: { sameRunAllowed: false, requiresUserChoice: true },
    userFacingRecovery: {
      presentationVersion: 1,
      whatHappened: 'The features available in this environment have changed since this plan was created.',
      workState: NO_NEW_WORK,
      resolution: 'Start a new attempt using the current environment.',
      options: [
        {
          action: 'restart_same_plan',
          label: 'Restart the same plan in the current environment',
          recommended: true,
          whenToChoose: 'The plan is still correct and only the available features have changed.',
          whatHappens: 'The current attempt is cancelled, and a new attempt starts with the current environment and the same agreed plan.',
        },
        {
          action: 'revise_then_restart',
          label: 'Review the plan before restarting',
          recommended: false,
          whenToChoose: 'The changed features should alter the scope, work items, or verification.',
          whatHappens: 'You are asked what to change; after you answer, the current attempt is cancelled and a new attempt starts with the current environment and revised plan.',
        },
        {
          action: 'cancel',
          label: 'Cancel',
          recommended: false,
          whenToChoose: 'You no longer want this work to continue.',
          whatHappens: 'The current attempt is cancelled, and no replacement attempt is created.',
        },
      ],
    },
  };
}

export function planStartRecoveryError(reason: PlanStartRecoveryReason): KiokukoError {
  return new KiokukoError('CONFLICT', 'Plan start requires an explicit recovery choice', {
    [PLAN_START_RECOVERY_DETAIL_KEY]: reason,
  });
}

export function renderPlanStartRecovery(recovery: PlanStartRecovery): string {
  const projection = recovery.userFacingRecovery;
  return [
    projection.whatHappened,
    projection.workState,
    projection.resolution,
    '',
    ...projection.options.flatMap((option, index) => [
      `${index + 1}. ${option.label}${option.recommended ? ' (Recommended)' : ''}`,
      `   Choose this when: ${option.whenToChoose}`,
      `   What happens: ${option.whatHappens}`,
    ]),
  ].join('\n');
}
