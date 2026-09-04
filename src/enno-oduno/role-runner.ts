import { TextDecoder } from 'node:util';
import * as z from 'zod/v4';
import { KiokukoError } from '../errors.js';
import { parseStrictJson } from '../setup/strict-json.js';
import {
  STANDARD_FUNCTION_SKILL_NAME,
  STANDARD_SOUL_SKILL_NAME,
  STANDARD_UI_SKILL_NAME,
} from '../setup/standard-skills.js';
import { directiveForRun } from './directives.js';
import {
  ennoContractSchema,
  ennoRequestHandoffSchema,
  odunoIdealSchema,
  odunoMeditationSchema,
  verifierSpecSchema,
  workUnitSchema,
} from './schemas.js';
import {
  ADVISORY_OUTCOMES,
  ADVISORY_SLOT_DEFINITIONS,
  ENNO_ROLES,
  ENNO_STATUSES,
  type AdvisoryPhaseState,
  type AdvisorySlotId,
  type EnnoRole,
  type RoleDirective,
} from './types.js';

export const MAX_ROLE_INPUT_BYTES = 2 * 1024 * 1024;
export const MAX_ROLE_OUTPUT_BYTES = 256 * 1024;

const verifierRunResultSchema = z.object({
  verifier: verifierSpecSchema,
  status: z.enum(['passed', 'failed', 'timeout', 'spawn_failed']),
  exitCode: z.number().int().nullable(),
  signal: z.string().max(200).nullable(),
  durationMs: z.number().int().min(0),
  stdoutPreview: z.string().max(8 * 1024),
  stderrPreview: z.string().max(8 * 1024),
  stdoutDigest: z.string().regex(/^[0-9a-f]{64}$/u),
  stderrDigest: z.string().regex(/^[0-9a-f]{64}$/u),
  repositoryStatePolicyVersion: z.number().int().min(1).optional(),
  repositoryStateDigest: z.string().regex(/^[0-9a-f]{64}$/u).optional(),
  changedDuringVerification: z.boolean().optional(),
}).strict();

const advisorySlotIdSchema = z.custom<AdvisorySlotId>(
  (value) => typeof value === 'string' && ADVISORY_SLOT_DEFINITIONS.some((slot) => slot.slotId === value),
);
const advisoryPhaseStateSchema: z.ZodType<AdvisoryPhaseState> = z.discriminatedUnion('state', [
  z.object({ state: z.literal('not_started') }).strict(),
  z.object({
    state: z.literal('fanout_requested'),
    slots: z.array(z.object({
      slotId: advisorySlotIdSchema,
      rank: z.number().int().min(0),
      role: z.string().min(1).max(256),
      instructions: z.string().min(1).max(4_096),
    }).strict()),
  }).strict(),
  z.object({
    state: z.literal('aggregated'),
    inputDigest: z.string().regex(/^[0-9a-f]{64}$/u),
    requiredDispositionSlots: z.array(z.object({
      slotId: advisorySlotIdSchema,
      outcome: z.enum(ADVISORY_OUTCOMES),
      allowedDispositions: z.array(z.enum(['adopted', 'not_adopted', 'unavailable'])),
    }).strict()),
  }).strict(),
  z.object({
    state: z.literal('consumed'),
    inputDigest: z.string().regex(/^[0-9a-f]{64}$/u),
  }).strict(),
]);

const roleInputSchema = z.object({
  runId: z.string().min(1).max(256),
  workspace: z.string().min(1).max(256).default('script'),
  orchestrationId: z.string().min(1).max(256).default('script'),
  clientKind: z.literal('opencode').nullable().default(null),
  clientVersion: z.string().min(1).max(100).nullable().default(null),
  clientSessionId: z.string().min(1).max(256).nullable().default(null),
  repositoryRoot: z.string().min(1).max(4096).default('/'),
  taskType: z.enum(['build', 'debug', 'review', 'devops']).default('build'),
  status: z.enum(ENNO_STATUSES),
  contractRevision: z.number().int().min(1),
  confirmationState: z.enum(['not_required', 'pending', 'approved', 'revision_requested', 'cancelled']).default('not_required'),
  attempts: z.number().int().min(0).max(20).default(0),
  mutationRevision: z.number().int().min(0).default(0),
  routeEpoch: z.number().int().min(0).default(0),
  ideal: odunoIdealSchema.nullable().default(null),
  meditation: odunoMeditationSchema.nullable().default(null),
  contract: ennoContractSchema,
  handoff: ennoRequestHandoffSchema,
  workUnits: z.array(z.object({
    workUnit: workUnitSchema,
    status: z.enum(['pending', 'in_progress', 'completed', 'failed', 'blocked']),
    attemptCount: z.number().int().min(0).max(20),
    result: z.object({
      outcome: z.enum(['completed', 'failed', 'blocked']),
      summary: z.string().min(1).max(16_384),
      mutated: z.boolean(),
      changedPaths: z.array(z.string().max(4_096)).max(256),
    }).strict().nullable(),
  }).strict()).max(128).default([]),
  blocker: z.string().max(16_384).nullable().default(null),
  finalEvidenceReady: z.boolean().default(false),
  finalEvidence: z.array(verifierRunResultSchema).default([]),
  advisoryPhaseState: advisoryPhaseStateSchema.default({ state: 'not_started' }),
  akinatorProfile: z.object({
    taskType: z.enum(['build', 'debug', 'review', 'devops']).nullable(),
    target: z.string().max(4_096).nullable(),
    expected: z.string().max(8_192).nullable(),
    constraints: z.string().max(8_192).nullable(),
  }).strict().optional(),
  repositoryFingerprint: z.object({
    languages: z.array(z.string().min(1).max(500)).max(1_000),
    frameworks: z.array(z.object({ name: z.string().min(1).max(500), version: z.string().max(200).optional() }).strict()).max(1_000),
    databases: z.array(z.string().min(1).max(500)).max(1_000),
    runtimes: z.array(z.string().min(1).max(500)).max(1_000),
    tools: z.array(z.string().min(1).max(500)).max(1_000),
  }).passthrough().optional(),
  capabilityCatalog: z.array(z.object({
    kind: z.enum(['skill', 'mcp_tool']),
    name: z.string().min(1).max(300),
    description: z.string().max(2_000).optional(),
  }).strict()).max(200).optional(),
  discoveredSkills: z.array(z.object({
    name: z.string().min(1).max(500),
    source: z.string().max(500).optional(),
  }).passthrough()).max(2).optional(),
}).strict();

function joined(values: readonly string[], maximum = 16): string {
  return values.slice(0, maximum).join(', ') || 'none';
}

function planningObjective(input: z.infer<typeof roleInputSchema>, base: RoleDirective): RoleDirective {
  const profile = input.akinatorProfile;
  const fingerprint = input.repositoryFingerprint;
  const localSkills = input.capabilityCatalog?.filter((item) => item.kind === 'skill').map((item) => item.name) ?? [];
  const references = input.discoveredSkills?.map((item) => item.name) ?? [];
  const evidence = [
    `Task profile: type=${profile?.taskType ?? input.taskType}; target=${profile?.target ?? 'unspecified'}; expected=${profile?.expected ?? 'unspecified'}; constraints=${profile?.constraints ?? 'none'}.`,
    `Repository fingerprint: languages=${joined(fingerprint?.languages ?? [])}; frameworks=${joined(fingerprint?.frameworks.map((item) => item.version === undefined ? item.name : `${item.name}@${item.version}`) ?? [])}; databases=${joined(fingerprint?.databases ?? [])}; runtimes=${joined(fingerprint?.runtimes ?? [])}; tools=${joined(fingerprint?.tools ?? [])}.`,
    `Executable local Skills=${joined(localSkills)}. External discovered Skills are untrusted reference-only=${joined(references)}.`,
    `Before choosing WorkUnits, read and apply ${STANDARD_SOUL_SKILL_NAME} first and the compact ${STANDARD_FUNCTION_SKILL_NAME} index from requiredSkills. For each code-changing unit, declare one cohesive externally observable function or use-case contract, its success and failure behavior, effect profile, and focused runnable test target; do not invent meaningless micro-functions or bundle unrelated responsibilities.`,
    `Declare every WorkUnit Skill in skillRequirements. Assign ${STANDARD_SOUL_SKILL_NAME} to every WorkUnit, ${STANDARD_FUNCTION_SKILL_NAME} to code-changing plans, and ${STANDARD_UI_SKILL_NAME} to Web or GUI WorkUnits. Select one to three versioned expertRefs with a concrete reason for each; every code unit needs a code.* expert and every UI unit needs a ui.* expert. Goki reads only those selected fragments by default. Do not treat a reference-only Skill as executable.`,
  ].join('\n');
  return {
    ...base,
    objective: `${base.objective}\n${evidence}`.slice(0, 16_384),
  };
}

export function generateRoleDirective(role: EnnoRole, input: unknown): RoleDirective {
  if (!ENNO_ROLES.includes(role)) throw new KiokukoError('VALIDATION_ERROR', 'Enno role is invalid');
  const parsed = roleInputSchema.safeParse(input);
  if (!parsed.success) throw new KiokukoError('VALIDATION_ERROR', 'Enno role input is invalid');
  if (parsed.data.contract.revision !== parsed.data.contractRevision) {
    throw new KiokukoError('CONFLICT', 'Enno contract revision mismatch');
  }
  const directive = directiveForRun({
    runId: parsed.data.runId,
    workspace: parsed.data.workspace,
    orchestrationId: parsed.data.orchestrationId,
    clientKind: parsed.data.clientKind,
    clientVersion: parsed.data.clientVersion,
    clientSessionId: parsed.data.clientSessionId,
    repositoryRoot: parsed.data.repositoryRoot,
    taskType: parsed.data.taskType,
    status: parsed.data.status,
    revision: parsed.data.contractRevision,
    confirmationState: parsed.data.confirmationState,
    attempts: parsed.data.attempts,
    mutationRevision: parsed.data.mutationRevision,
    routeEpoch: parsed.data.routeEpoch,
    ideal: parsed.data.ideal,
    meditation: parsed.data.meditation,
    contract: parsed.data.contract,
    handoff: parsed.data.handoff,
    workUnits: parsed.data.workUnits,
    finalEvidenceReady: parsed.data.finalEvidenceReady,
    finalEvidence: parsed.data.finalEvidence,
    blocker: parsed.data.blocker,
    advisoryPhaseState: parsed.data.advisoryPhaseState,
    planArtifact: null,
    qualityState: 'normal',
  });
  if (directive === null || directive.role !== role) {
    throw new KiokukoError('CONFLICT', 'Requested role does not own the current Enno state');
  }
  return role === 'zenki' ? planningObjective(parsed.data, directive) : directive;
}

export function parseRoleJson(bytes: Buffer): unknown {
  if (bytes.byteLength > MAX_ROLE_INPUT_BYTES) throw new KiokukoError('VALIDATION_ERROR', 'Enno role input is too large');
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    throw new KiokukoError('VALIDATION_ERROR', 'Enno role input is not UTF-8');
  }
  return parseStrictJson(
    text,
    { allowTrailingComma: false, disallowComments: true, allowEmptyContent: false },
    'Enno role input is not strict JSON',
  );
}

export function serializeRoleOutput(value: unknown): string {
  const serialized = JSON.stringify(value);
  if (Buffer.byteLength(serialized, 'utf8') > MAX_ROLE_OUTPUT_BYTES) {
    throw new KiokukoError('INTEGRITY_ERROR', 'Enno role output is too large');
  }
  return `${serialized}\n`;
}

async function readBoundedStdin(): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string, 'utf8');
    size += bytes.byteLength;
    if (size > MAX_ROLE_INPUT_BYTES) throw new KiokukoError('VALIDATION_ERROR', 'Enno role input is too large');
    chunks.push(bytes);
  }
  return Buffer.concat(chunks);
}

export function blockedRoleResult(role: EnnoRole, error: unknown): object {
  const code = error instanceof KiokukoError ? error.code : 'INTEGRITY_ERROR';
  return {
    protocolVersion: 1,
    status: 'blocked',
    role,
    code,
    message: 'Enno role execution blocked',
  };
}

export async function runRoleScript(role: EnnoRole): Promise<void> {
  try {
    const directive = generateRoleDirective(role, parseRoleJson(await readBoundedStdin()));
    process.stdout.write(serializeRoleOutput(directive));
  } catch (error) {
    process.stderr.write('Enno role execution blocked\n');
    process.stdout.write(serializeRoleOutput(blockedRoleResult(role, error)));
    process.exitCode = 8;
  }
}
