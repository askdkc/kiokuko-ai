export type SkillSourceFailureCode =
  | 'source_missing'
  | 'source_rate_limited'
  | 'source_unavailable'
  | 'candidate_not_found_at_source'
  | 'source_tree_truncated'
  | 'skill_disabled_for_model_invocation'
  | 'skill_secret_detected'
  | 'skill_too_large'
  | 'skill_validation_failed'
  | 'skill_blocked';

/** A bounded, externally safe failure produced by source retrieval or validation. */
export class SkillSourceError extends Error {
  readonly code: SkillSourceFailureCode;
  readonly retryAfterSeconds: number | null;

  constructor(code: SkillSourceFailureCode, retryAfterSeconds: number | null = null) {
    super(code);
    this.name = 'SkillSourceError';
    this.code = code;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

export function skillSourceFailure(code: SkillSourceFailureCode): never {
  throw new SkillSourceError(code);
}
