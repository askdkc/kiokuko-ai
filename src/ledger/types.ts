export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };

export const MAX_BATCH_EVENTS = 200;
export const MAX_EVENT_PAYLOAD_BYTES = 64 * 1024;
export const MAX_PREVIEW_BYTES = 4 * 1024;
export const MAX_ID_LENGTH = 256;
export const MAX_TEXT_LENGTH = 16 * 1024;

export const LEDGER_EVENT_TYPES = [
  'intake.started', 'intake.answered', 'intake.ready', 'intake.exhausted',
  'run.started', 'run.closed', 'request.received', 'constraint.recorded',
  'decision.recorded', 'step.started', 'step.completed', 'step.failed',
  'approval.requested', 'approval.decided', 'tool.requested', 'tool.started',
  'tool.completed', 'tool.failed', 'tool.outcome_unknown', 'command.started',
  'command.completed', 'file.observed', 'file.changed', 'test.started',
  'test.completed', 'verification.recorded', 'error.recorded', 'retry.recorded',
  'cancellation.recorded', 'context.used', 'context.feedback', 'memory.proposed',
  'memory.promoted', 'task_profile.revised', 'correction.recorded', 'source.event',
  'enno.started', 'enno.client_bound', 'enno.client_rebound', 'enno.advice_submitted', 'enno.advice_disposition', 'oduno.ideal_derived', 'zenki.plan_created', 'enno.plan_confirmed',
  'goki.work_started', 'goki.work_completed', 'goki.work_failed',
  'enno.review_started', 'enno.review_accepted', 'enno.replan_requested',
  'enno.verification_started', 'enno.verification_passed', 'enno.verification_failed',
  'oduno.meditation_completed', 'enno.completed', 'enno.blocked', 'enno.cancelled',
] as const;
export type LedgerEventType = (typeof LEDGER_EVENT_TYPES)[number];

export const CAPTURE_PROFILES = ['minimal', 'standard', 'diagnostic'] as const;
export type CaptureProfile = (typeof CAPTURE_PROFILES)[number];

export const COVERAGE_LEVELS = ['complete', 'best_effort', 'declared', 'unavailable'] as const;
export type CoverageLevel = (typeof COVERAGE_LEVELS)[number];

export const RUN_STATUSES = ['intake', 'active', 'completed', 'failed', 'cancelled', 'interrupted'] as const;
export type RunStatus = (typeof RUN_STATUSES)[number];
export const TERMINAL_RUN_STATUSES = ['completed', 'failed', 'cancelled', 'interrupted'] as const;

export const TASK_TYPES = ['build', 'debug', 'research', 'review', 'devops', 'writing', 'analysis'] as const;
export type TaskType = (typeof TASK_TYPES)[number];

export interface Coverage {
  run: CoverageLevel;
  tool: CoverageLevel;
  command: CoverageLevel;
  file: CoverageLevel;
  approval: CoverageLevel;
}

export interface ClientInput {
  kind: string;
  version?: string;
  sessionId?: string;
}

export interface ProfileHints {
  taskType: TaskType | null;
  target: string | null;
  expected: string | null;
  constraints: JsonValue | null;
}

export interface TaskInput {
  title: string;
  query: string;
  profileHints: ProfileHints;
}

export interface AnswerInput {
  apiVersion: '1';
  questionId: string;
  value: JsonValue;
}

export interface CreateRunInput {
  runId: string;
  workspace: string;
  protocolVersion: '1';
  client: ClientInput;
  captureProfile: CaptureProfile;
  coverage: Coverage;
  task: TaskInput;
  metadata?: JsonObject;
  parentRunId?: string;
  startedAt?: string;
}

export interface LedgerEventInput {
  eventId?: string;
  sourceEventId?: string;
  sourceSequence?: number;
  eventType: LedgerEventType;
  sourceType?: string;
  actor: string;
  outcome?: string | null;
  occurredAt?: string;
  payload: JsonValue;
}

export interface Redaction {
  path: string;
  kind: 'sensitive_key' | 'secret_pattern' | 'url' | 'home_path' | 'preview_truncated' | 'environment_value' | 'hidden_reasoning';
}

export interface SanitizationOptions {
  workspace?: string;
  home?: string;
}

export interface Sanitized<T> {
  value: T;
  redactions: Redaction[];
  truncated: string[];
}

export interface RunRecord {
  runId: string;
  workspace: string;
  client: ClientInput;
  protocolVersion: string;
  captureProfile: CaptureProfile;
  coverage: Coverage;
  status: RunStatus;
  title: string | null;
  taskHash: string | null;
  metadata: JsonObject;
  lastSequence: number;
  lastSourceSequence: number | null;
  startedAt: string;
  endedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface AppendAck {
  runId: string;
  acceptedThrough: number;
  localSequences: number[];
  sourceSequences: Array<number | null>;
  eventIds: string[];
}

export interface LedgerStoreOptions extends SanitizationOptions {
  now?: () => string;
}
