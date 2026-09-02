import * as z from 'zod/v4';
import { ENTRY_KINDS } from '../serialization/validate.js';
import {
  CHECKPOINT_OUTCOMES,
  CHECKPOINT_RUN_ID_DESCRIPTION,
  MAX_CHECKPOINT_FEEDBACK_ITEMS,
  MAX_CHECKPOINT_MEMORY_ITEMS,
  checkpointEvidenceSchema,
  checkpointFeedbackSchema,
  hasCheckpointEvidenceContent,
} from '../ledger/checkpoint-contract.js';
import { absoluteCwdSchema } from '../repository/cwd-schema.js';

const memoryKind = z.enum(ENTRY_KINDS);
const memoryClass = z.enum([
  'implementation-pattern', 'troubleshooting', 'tool-usage', 'extension-usage',
  'configuration', 'workflow', 'gotcha', 'reference', 'preference',
]);
const applicability = z.object({
  languages: z.array(z.string().trim().min(1).max(500)).max(100).optional(),
  frameworks: z.array(z.object({
    name: z.string().trim().min(1).max(500),
    version: z.string().trim().min(1).max(100).optional(),
  }).strict()).max(50).optional(),
  databases: z.array(z.string().trim().min(1).max(500)).max(100).optional(),
  runtimes: z.array(z.string().trim().min(1).max(500)).max(100).optional(),
  tools: z.array(z.string().trim().min(1).max(500)).max(100).optional(),
  platforms: z.array(z.string().trim().min(1).max(500)).max(100).optional(),
}).strict();
const signals = z.object({
  symbols: z.array(z.string().trim().min(1).max(500)).max(100).optional(),
  paths: z.array(z.string().trim().min(1).max(500)).max(100).optional(),
  errors: z.array(z.string().trim().min(1).max(500)).max(100).optional(),
  packages: z.array(z.string().trim().min(1).max(500)).max(100).optional(),
  commands: z.array(z.string().trim().min(1).max(500)).max(100).optional(),
}).strict();

export const checkpointMemorySchema = z.object({
  kind: memoryKind,
  title: z.string().trim().min(1).max(300),
  body: z.string().max(20_000),
  summary: z.string().max(2000).optional(),
  scope: z.enum(['project', 'global']).default('project'),
  retrievalScope: z.enum(['project-only', 'ecosystem', 'global']).optional(),
  tags: z.array(z.string().trim().min(1).max(200)).max(20).optional(),
  confidence: z.number().min(0).max(1).default(0.7),
  memoryClass: memoryClass.optional(),
  applicability: applicability.optional(),
  signals: signals.optional(),
  portableReason: z.string().trim().min(1).max(2000).optional(),
}).strict();

const checkpointRunId = z.string().min(1).max(256).refine(
  (value) => value.trim() === value && !/\p{Cc}/u.test(value),
  { message: 'runId must be a canonical bounded identity' },
).describe(CHECKPOINT_RUN_ID_DESCRIPTION);
const checkpointDeliveryId = z.string().min(1).max(256).refine(
  (value) => value.trim() === value && !/\p{Cc}/u.test(value),
  { message: 'deliveryId must be a canonical bounded identity' },
);

type CheckpointContent = {
  memories?: readonly unknown[] | undefined;
  feedback?: readonly unknown[] | undefined;
  evidence?: Parameters<typeof hasCheckpointEvidenceContent>[0];
};

function hasCheckpointContent(value: CheckpointContent): boolean {
  return (value.memories?.length ?? 0) > 0
    || (value.feedback?.length ?? 0) > 0
    || hasCheckpointEvidenceContent(value.evidence);
}

function addIssue(context: z.RefinementCtx, path: string[], message: string): void {
  context.addIssue({ code: 'custom', path, message });
}

function refineRunBoundCheckpoint(value: CheckpointContent & { outcome?: unknown; deliveryId?: unknown }, context: z.RefinementCtx): void {
  if (value.outcome === undefined) addIssue(context, ['outcome'], 'outcome is required when runId is supplied');
  if (!hasCheckpointContent(value)) addIssue(context, [], 'A run-bound checkpoint requires memory, feedback, or non-empty evidence');
  if ((value.feedback?.length ?? 0) > 0 && value.deliveryId === undefined) {
    addIssue(context, ['deliveryId'], 'deliveryId is required when feedback is supplied');
  }
}

export const runBoundCheckpointSchema = z.object({
  cwd: absoluteCwdSchema.optional(),
  runId: checkpointRunId,
  deliveryId: checkpointDeliveryId.optional(),
  outcome: z.enum(CHECKPOINT_OUTCOMES),
  memories: z.array(checkpointMemorySchema).max(MAX_CHECKPOINT_MEMORY_ITEMS).optional(),
  feedback: z.array(checkpointFeedbackSchema).max(MAX_CHECKPOINT_FEEDBACK_ITEMS).optional(),
  evidence: checkpointEvidenceSchema.optional(),
}).strict().superRefine((value, context) => refineRunBoundCheckpoint(value, context));

export const standaloneMemoryCheckpointSchema = z.object({
  cwd: absoluteCwdSchema.optional(),
  memories: z.array(checkpointMemorySchema).min(1).max(MAX_CHECKPOINT_MEMORY_ITEMS),
}).strict();

export const memoryCheckpointVariantsSchema = z.union([
  runBoundCheckpointSchema,
  standaloneMemoryCheckpointSchema,
]);

function refineCheckpointInput(value: CheckpointContent & {
  runId?: unknown;
  deliveryId?: unknown;
  outcome?: unknown;
}, context: z.RefinementCtx): void {
  if (value.runId !== undefined) {
    refineRunBoundCheckpoint(value, context);
    return;
  }

  if ((value.memories?.length ?? 0) === 0) addIssue(context, ['memories'], 'Without runId, at least one memory is required');
  if (value.outcome !== undefined) addIssue(context, ['outcome'], 'outcome is only valid for a run-bound checkpoint');
  if (value.deliveryId !== undefined) addIssue(context, ['deliveryId'], 'deliveryId requires runId');
  if (value.feedback !== undefined) addIssue(context, ['feedback'], 'feedback requires runId');
  if (value.evidence !== undefined) addIssue(context, ['evidence'], 'evidence requires runId');
}

// The MCP SDK only serializes object schemas in tools/list; a union would be
// advertised as an empty schema. This closed object retains the same runtime
// cross-field contract while keeping the public property schema visible.
export const memoryCheckpointInputSchema = z.object({
  cwd: absoluteCwdSchema.optional(),
  memories: z.array(checkpointMemorySchema).max(MAX_CHECKPOINT_MEMORY_ITEMS).optional(),
  runId: checkpointRunId.optional(),
  deliveryId: checkpointDeliveryId.optional(),
  outcome: z.enum(CHECKPOINT_OUTCOMES).optional(),
  feedback: z.array(checkpointFeedbackSchema).max(MAX_CHECKPOINT_FEEDBACK_ITEMS).optional(),
  evidence: checkpointEvidenceSchema.optional(),
}).strict().superRefine((value, context) => refineCheckpointInput(value, context));
