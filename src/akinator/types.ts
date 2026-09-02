import type { EntryRecord } from '../memory/entries.js';

export const TASK_TYPES = ['build', 'debug', 'research', 'review', 'devops', 'writing', 'analysis'] as const;
export type TaskType = (typeof TASK_TYPES)[number];

export interface TaskProfile {
  taskType: TaskType | null;
  target: string | null;
  expected: string | null;
  constraints: string | null;
}

export interface AkinatorQuestion {
  id: keyof TaskProfile;
  prompt: string;
  options: string[] | null;
  required: boolean;
}

export type AkinatorReasoningStage = 'exploring' | 'narrowing' | 'actionable';

export interface ActionHypothesis {
  id: TaskType;
  label: string;
  description: string;
  status: 'possible' | 'rejected' | 'selected';
}

export interface ReasoningSiloLevel {
  level: 'intent' | 'action-family' | 'target' | 'success' | 'action' | 'verification';
  status: 'resolved' | 'missing';
  value: string | null;
}

export interface AkinatorReasoning {
  policyVersion: string;
  stage: AkinatorReasoningStage;
  hypotheses: ActionHypothesis[];
  questions: Array<{
    id: keyof TaskProfile;
    status: 'answered' | 'pending';
    purpose: string;
    discriminates: string[];
  }>;
  selectedAction: string | null;
  conditions: string[];
  verification: string[];
  stopConditions: string[];
  silo: {
    levels: ReasoningSiloLevel[];
    resolved: number;
    total: number;
    completeness: number;
  };
}

export interface AkinatorSessionView {
  id: string;
  workspace: string;
  task: string;
  profile: TaskProfile;
  status: 'active' | 'ready' | 'exhausted';
  questionCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface AkinatorResult {
  status: 'needs_answer' | 'ready' | 'exhausted';
  session: AkinatorSessionView;
  question: AkinatorQuestion | null;
  missingFields: Array<keyof TaskProfile>;
  recommendedTags: string[];
}

export interface AkinatorContext extends AkinatorResult {
  entries: EntryRecord[];
  instructions: string[];
}
