import { z } from 'zod';
import { KiokukoError } from '../errors.js';
import { findSecret } from '../memory/secrets.js';
import type { TaskProfile } from './types.js';

export const PROFILE_MEMORY_POLICY = 'profile-memory-v1' as const;
export const PROFILE_CANDIDATE_LIMIT = 64;
export const PROFILE_HINT_LIMIT = 3;
export const PROFILE_TEXT_LIMIT = 512;
export const probeModeSchema = z.enum(['off', 'shadow', 'suggest', 'resolve']);
export type ProbeMode = z.infer<typeof probeModeSchema>;
const id = z.string().min(1).max(256).regex(/^[^\p{Cc}]+$/u);
const hash = z.string().regex(/^[a-f0-9]{64}$/u);
export const profileEvidenceSchema = z.object({
  runId: id, sessionId: id, workspace: id, repositoryId: id,
  profileHash: hash, sourcesHash: hash,
  score: z.number().finite().min(0).max(100),
}).strict();
export type ProfileEvidence = z.infer<typeof profileEvidenceSchema>;
export const memoryResolutionSchema = z.object({
  policyVersion: z.literal(PROFILE_MEMORY_POLICY), mode: probeModeSchema,
  status: z.enum(['skipped', 'complete', 'incomplete', 'unavailable']),
  coverage: z.enum(['complete', 'partial']),
  baseProfileHash: hash, resultProfileHash: hash,
  candidates: z.array(profileEvidenceSchema).max(PROFILE_CANDIDATE_LIMIT),
  adopted: profileEvidenceSchema.nullable(),
  shadowAdoption: profileEvidenceSchema.nullable().optional(),
  scannedCandidates: z.number().int().min(0).max(PROFILE_CANDIDATE_LIMIT),
  queryCount: z.number().int().min(0).max(3),
  truncated: z.boolean(),
  warning: z.enum(['path_permission_denied', 'path_resources_exhausted']).optional(),
}).strict();
export type MemoryResolution = z.infer<typeof memoryResolutionSchema>;
export interface ProfileMemoryHints {
  untrusted: true;
  status: MemoryResolution['status'];
  coverage: MemoryResolution['coverage'];
  truncated: boolean;
  candidates: Array<{ field: keyof TaskProfile; value: string; reason: string; source: ProfileEvidence }>;
}

export function readProbeMode(env: NodeJS.ProcessEnv = process.env): ProbeMode {
  const result = probeModeSchema.safeParse(env.KIOKUKO_AKINATOR_MEMORY_MODE ?? 'off');
  if (!result.success) throw new KiokukoError('VALIDATION_ERROR', 'KIOKUKO_AKINATOR_MEMORY_MODE must be off, shadow, suggest, or resolve');
  return result.data;
}

export function parseMemoryResolution(value: unknown): MemoryResolution {
  const result = memoryResolutionSchema.safeParse(value);
  if (!result.success || findSecret(JSON.stringify(result.data))) {
    throw new KiokukoError('INTEGRITY_ERROR', 'Stored profile memory resolution is invalid');
  }
  const data = result.data;
  if (new Set(data.candidates.map(item => item.runId)).size !== data.candidates.length
    || data.scannedCandidates < data.candidates.length) {
    throw new KiokukoError('INTEGRITY_ERROR', 'Stored profile memory candidate set is invalid');
  }
  for (const [mode, candidate] of [['resolve', data.adopted], ['shadow', data.shadowAdoption]] as const) {
    if (candidate && (data.mode !== mode || data.status !== 'complete'
      || data.coverage !== 'complete' || data.truncated
      || !data.candidates.some(item => item.runId === candidate.runId
        && item.sessionId === candidate.sessionId && item.workspace === candidate.workspace
        && item.repositoryId === candidate.repositoryId && item.score === candidate.score
        && item.profileHash === candidate.profileHash && item.sourcesHash === candidate.sourcesHash))) {
      throw new KiokukoError('INTEGRITY_ERROR', 'Stored profile memory adoption is invalid');
    }
  }
  return data;
}

export const profileHintSnapshotSchema = z.object({
  untrusted: z.literal(true), status: memoryResolutionSchema.shape.status,
  coverage: memoryResolutionSchema.shape.coverage, truncated: z.boolean(),
  candidates: z.array(z.object({
    field: z.enum(['taskType', 'target', 'expected', 'constraints']),
    value: z.string().min(1).max(PROFILE_TEXT_LIMIT).optional(),
    reason: z.enum(['previous_success_condition_only', 'previous_constraint_not_authorization', 'previous_profile_candidate']),
    source: profileEvidenceSchema,
  }).strict()).max(4 * PROFILE_HINT_LIMIT),
}).strict();

export function parseProfileHintSnapshot(value: unknown) {
  const result = profileHintSnapshotSchema.safeParse(value);
  if (!result.success) throw new KiokukoError('INTEGRITY_ERROR', 'Stored profile memory hints are invalid');
  return result.data;
}

/** Optional profile assistance must not turn an invalid operator setting into a coding gate. */
export function runtimeProbeConfig(env: NodeJS.ProcessEnv = process.env): { mode: ProbeMode; warning: boolean } {
  try { return { mode: readProbeMode(env), warning: false }; }
  catch (error) {
    if (!(error instanceof KiokukoError) || error.code !== 'VALIDATION_ERROR') throw error;
    return { mode: 'off', warning: true };
  }
}
