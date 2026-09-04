import * as z from 'zod/v4';
import { isWellFormedUnicode } from '../serialization/boundary-json.js';

export const CHECKPOINT_RUN_NOT_ACTIVE_CODE = 'CHECKPOINT_RUN_NOT_ACTIVE' as const;

export const CHECKPOINT_INTAKE_ERROR_MESSAGE =
  'Checkpoint could not bind to an active run.';

export const CHECKPOINT_TERMINAL_ERROR_MESSAGE =
  'Checkpoint is blocked because the run is terminal.';

export const TASK_ANSWER_CONTRACT_FRAGMENT =
  'Use the exact current question. If question.options is non-null, value must be exactly one returned option. If options is null, provide grounded non-empty text. Answers are advisory enrichment: unresolved questions do not suspend coding. Preserve unresolved fields and evidence boundaries at checkpoint.';

export const CHECKPOINT_CONTRACT_FRAGMENT =
  'For a run-bound checkpoint, `runId` and `outcome` are required, the run must be active, and at least one of memories, feedback, or non-empty evidence must be supplied. outcome alone is an invalid empty checkpoint. Do not invent evidence fields such as checks; use commands and/or tests. Without `runId`, provide at least one memory and omit run-bound fields. An unresolved advisory intake question does not block checkpointing: record the current profile, unresolved items, and evidence boundary. A successful terminal checkpoint is allowed at most once per logical request.';

export const CHECKPOINT_TOOL_DESCRIPTION =
  `Store one final batch of durable facts, decisions, lessons, preferences, or references as untrusted candidate memory. ${CHECKPOINT_CONTRACT_FRAGMENT} After a successful terminal checkpoint, call no more tools and return the final response. Defaults to the current project. Use Curator for learned knowledge that may become global; choose direct global scope only when the user explicitly requested it. Secret-like content is rejected.`;

export const CHECKPOINT_RUN_ID_DESCRIPTION =
  'Exact run.runId returned by task_prepare. The run must be active; advisory intake questions may remain unresolved.';

export const CHECKPOINT_OUTCOMES = ['completed', 'failed', 'cancelled', 'interrupted'] as const;
export type CheckpointOutcome = (typeof CHECKPOINT_OUTCOMES)[number];

export const CHECKPOINT_RESULT_OUTCOMES = ['passed', 'failed', 'unknown'] as const;
export type CheckpointResultOutcome = (typeof CHECKPOINT_RESULT_OUTCOMES)[number];

export const CHECKPOINT_VERIFICATION_OUTCOMES = ['fresh', 'stale', 'failed', 'unknown'] as const;
export type CheckpointVerificationOutcome = (typeof CHECKPOINT_VERIFICATION_OUTCOMES)[number];

export const CONTEXT_FEEDBACK_VERDICTS = ['helpful', 'irrelevant', 'stale', 'conflicting'] as const;
export type ContextFeedbackVerdict = (typeof CONTEXT_FEEDBACK_VERDICTS)[number];

export const CHECKPOINT_EVIDENCE_FIELD_NAMES = [
  'changedPaths', 'errorSignatures', 'commands', 'tests', 'verification',
] as const;
export const CHECKPOINT_COMMAND_FIELD_NAMES = [
  'executable', 'classification', 'exitCode', 'outcome', 'digest',
] as const;
export const CHECKPOINT_TEST_FIELD_NAMES = ['runner', 'target', 'outcome', 'digest'] as const;
export const CHECKPOINT_VERIFICATION_FIELD_NAMES = ['outcome'] as const;
export const CHECKPOINT_FEEDBACK_FIELD_NAMES = ['entryId', 'entryRevision', 'verdict', 'comment'] as const;

export const MAX_CHECKPOINT_MEMORY_ITEMS = 20;
export const MAX_CHECKPOINT_EVIDENCE_ITEMS = 100;
export const MAX_CHECKPOINT_PATHS = 200;
export const MAX_CHECKPOINT_SIGNALS = 200;
export const MAX_CHECKPOINT_SHORT_TEXT_CHARS = 500;
export const MAX_CHECKPOINT_EXECUTABLE_CHARS = 200;
export const MAX_CHECKPOINT_FEEDBACK_ITEMS = 100;
export const MAX_FEEDBACK_COMMENT_BYTES = 4 * 1024;
export const MAX_FEEDBACK_IDENTIFIER_LENGTH = 256;

export interface CheckpointCommandEvidence {
  executable: string;
  classification?: string | undefined;
  exitCode?: number | undefined;
  outcome: CheckpointResultOutcome;
  digest?: string | undefined;
}

export interface CheckpointTestEvidence {
  runner: string;
  target?: string | undefined;
  outcome: CheckpointResultOutcome;
  digest?: string | undefined;
}

export interface CheckpointEvidence {
  changedPaths?: string[] | undefined;
  errorSignatures?: string[] | undefined;
  commands?: CheckpointCommandEvidence[] | undefined;
  tests?: CheckpointTestEvidence[] | undefined;
  verification?: { outcome: CheckpointVerificationOutcome } | undefined;
}

export interface NormalizedCheckpointEvidence {
  changedPaths: string[];
  errorSignatures: string[];
  commands: CheckpointCommandEvidence[];
  tests: CheckpointTestEvidence[];
  verification?: { outcome: CheckpointVerificationOutcome };
}

export interface CheckpointFeedback {
  entryId: string;
  entryRevision: number;
  verdict: ContextFeedbackVerdict;
  comment?: string | undefined;
}

export function hasCheckpointEvidenceContent(evidence: CheckpointEvidence | undefined): boolean {
  return evidence !== undefined
    && ((evidence.changedPaths?.length ?? 0) > 0
      || (evidence.errorSignatures?.length ?? 0) > 0
      || (evidence.commands?.length ?? 0) > 0
      || (evidence.tests?.length ?? 0) > 0
      || evidence.verification !== undefined);
}

function validCheckpointText(value: string): boolean {
  return isWellFormedUnicode(value) && !/\p{Cc}/u.test(value);
}

function checkpointIdentifierSchema(label: string): z.ZodString {
  return z.string().min(1).max(MAX_FEEDBACK_IDENTIFIER_LENGTH).refine(
    (value) => value.trim() === value && validCheckpointText(value),
    { message: `${label} must be a canonical bounded identity` },
  );
}

function checkpointTextSchema(maximum: number, label: string): z.ZodString {
  return z.string().min(1).max(maximum).refine(
    validCheckpointText,
    { message: `${label} must be bounded text without control characters` },
  );
}

function relativeCheckpointPath(value: string): boolean {
  return validCheckpointText(value)
    && !value.startsWith('/')
    && !value.startsWith('\\')
    && !/^[A-Za-z]:/u.test(value)
    && !value.split(/[\\/]/u).includes('..');
}

export const checkpointPathSchema = z.string().min(1).max(MAX_CHECKPOINT_SHORT_TEXT_CHARS).refine(
  relativeCheckpointPath,
  { message: 'changedPaths must contain relative paths without parent traversal' },
);
export const checkpointSignalSchema = checkpointTextSchema(MAX_CHECKPOINT_SHORT_TEXT_CHARS, 'errorSignatures');

export const checkpointCommandEvidenceSchema = z.object({
  executable: checkpointTextSchema(MAX_CHECKPOINT_EXECUTABLE_CHARS, 'executable'),
  classification: checkpointTextSchema(MAX_CHECKPOINT_SHORT_TEXT_CHARS, 'classification').optional(),
  exitCode: z.number().int().nonnegative().safe().optional(),
  outcome: z.enum(CHECKPOINT_RESULT_OUTCOMES),
  digest: checkpointTextSchema(MAX_CHECKPOINT_SHORT_TEXT_CHARS, 'digest').optional(),
}).strict();

export const checkpointTestEvidenceSchema = z.object({
  runner: checkpointTextSchema(MAX_CHECKPOINT_EXECUTABLE_CHARS, 'runner'),
  target: checkpointTextSchema(MAX_CHECKPOINT_SHORT_TEXT_CHARS, 'target').optional(),
  outcome: z.enum(CHECKPOINT_RESULT_OUTCOMES),
  digest: checkpointTextSchema(MAX_CHECKPOINT_SHORT_TEXT_CHARS, 'digest').optional(),
}).strict();

export const checkpointVerificationSchema = z.object({
  outcome: z.enum(CHECKPOINT_VERIFICATION_OUTCOMES),
}).strict();

export const checkpointEvidenceSchema = z.object({
  changedPaths: z.array(checkpointPathSchema).max(MAX_CHECKPOINT_PATHS).optional(),
  errorSignatures: z.array(checkpointSignalSchema).max(MAX_CHECKPOINT_SIGNALS).optional(),
  commands: z.array(checkpointCommandEvidenceSchema).max(MAX_CHECKPOINT_EVIDENCE_ITEMS).optional(),
  tests: z.array(checkpointTestEvidenceSchema).max(MAX_CHECKPOINT_EVIDENCE_ITEMS).optional(),
  verification: checkpointVerificationSchema.optional(),
}).strict().superRefine((value, context) => {
  if (!hasCheckpointEvidenceContent(value)) {
    context.addIssue({ code: 'custom', message: 'Evidence must contain at least one item' });
  }
});

export const checkpointFeedbackSchema = z.object({
  entryId: checkpointIdentifierSchema('entryId').describe('Exact entry ID from the bound context delivery'),
  entryRevision: z.number().int().positive().safe(),
  verdict: z.enum(CONTEXT_FEEDBACK_VERDICTS),
  comment: z.string().min(1).max(MAX_FEEDBACK_COMMENT_BYTES).refine(
    (value) => Buffer.byteLength(value, 'utf8') <= MAX_FEEDBACK_COMMENT_BYTES && validCheckpointText(value),
    { message: 'comment must fit the UTF-8 byte limit and contain no control characters' },
  ).optional(),
}).strict();
