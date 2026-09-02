import {
  STANDARD_FUNCTION_EXPERT_IDS,
  STANDARD_UI_EXPERT_IDS,
} from '../setup/standard-skills.js';
import type { WorkPlan } from './types.js';
import { ennoValidationError } from './validation-errors.js';

const functionExpertIds = new Set<string>(STANDARD_FUNCTION_EXPERT_IDS);
const uiExpertIds = new Set<string>(STANDARD_UI_EXPERT_IDS);

function hasExpert(unit: WorkPlan['units'][number], expertIds: ReadonlySet<string>): boolean {
  return unit.expertRefs.some((reference) => expertIds.has(reference.id));
}

export function assertWorkPlanExpertCoverage(
  workPlan: WorkPlan,
): void {
  for (const [index, unit] of workPlan.units.entries()) {
    const requiresCode = unit.routes.includes('code') || unit.routes.includes('ui');
    const requiresUi = unit.routes.includes('ui');
    if (requiresCode && !hasExpert(unit, functionExpertIds)) {
      throw ennoValidationError('plan_submit', [{
        path: ['workPlan', 'units', index, 'expertRefs'],
        reasonCode: 'missing_code_expert',
        expected: { requiredExpertKinds: ['code'] },
      }]);
    }
    if (requiresUi && !hasExpert(unit, uiExpertIds)) {
      throw ennoValidationError('plan_submit', [{
        path: ['workPlan', 'units', index, 'expertRefs'],
        reasonCode: 'missing_ui_expert',
        expected: { requiredExpertKinds: ['ui'] },
      }]);
    }
  }
}
