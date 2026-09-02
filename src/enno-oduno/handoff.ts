import { KiokukoError } from '../errors.js';
import type { AkinatorReasoning, TaskProfile } from '../akinator/types.js';
import { ENNO_APPLICABLE_TASK_TYPES, type EnnoRequestHandoff } from './types.js';

export function buildEnnoRequestHandoff(
  profile: TaskProfile,
  reasoning: AkinatorReasoning,
): EnnoRequestHandoff {
  if (profile.taskType === null || !ENNO_APPLICABLE_TASK_TYPES.includes(
    profile.taskType as (typeof ENNO_APPLICABLE_TASK_TYPES)[number],
  ) || reasoning.selectedAction === null) {
    throw new KiokukoError('INTEGRITY_ERROR', 'Akinator did not produce an actionable Enno handoff');
  }
  return {
    sourceRole: 'enno-oduno',
    taskType: profile.taskType as (typeof ENNO_APPLICABLE_TASK_TYPES)[number],
    objective: reasoning.selectedAction,
    target: profile.target,
    expected: profile.expected,
    constraints: [...reasoning.conditions],
    verification: [...reasoning.verification],
    stopConditions: [...reasoning.stopConditions],
  };
}
