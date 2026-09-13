import type { TaskProfile } from './types.js';
import type { ProfileDocument } from './profile-memory-store.js';
import { PROFILE_HINT_LIMIT, PROFILE_TEXT_LIMIT, type ProfileMemoryHints, type MemoryResolution } from './memory-probe-types.js';

export function resolveProfileTarget(input: {
  profile: TaskProfile;
  candidates: readonly ProfileDocument[];
  verifiedTargets: ReadonlySet<string>;
  complete: boolean;
}): ProfileDocument | undefined {
  if (input.profile.target !== null || !input.complete) return undefined;
  // A conflicting target anywhere in the retrieved set prevents adoption, regardless of rank.
  const targets = new Set(input.candidates.map(item => item.session.profile.target).filter(value => value !== null));
  if (targets.size !== 1) return undefined;
  return input.candidates.find(item => {
    const target = item.session.profile.target;
    return target !== null && input.verifiedTargets.has(target) && item.completed && item.targetOriginVerified
      && (item.sources.target === 'user_answer' || item.sources.target === 'client_supplied');
  });
}

/** Suggestions cannot authorize a side effect or change any existing profile value. */
export function buildProfileHints(profile: TaskProfile, resolution: MemoryResolution, documents: readonly ProfileDocument[]): ProfileMemoryHints {
  const candidates: ProfileMemoryHints['candidates'] = [];
  for (const field of ['taskType', 'target', 'expected', 'constraints'] as const) {
    if (profile[field] !== null) continue;
    const seen = new Set<string>();
    for (const document of documents) {
      const value = document.session.profile[field];
      if (value === null || value.length > PROFILE_TEXT_LIMIT || seen.has(value)) continue;
      seen.add(value);
      candidates.push({ field, value, source: document.evidence,
        reason: field === 'expected' ? 'previous_success_condition_only' : field === 'constraints' ? 'previous_constraint_not_authorization' : 'previous_profile_candidate' });
      if (seen.size === PROFILE_HINT_LIMIT) break;
    }
  }
  return { untrusted: true, status: resolution.status, coverage: resolution.coverage, truncated: resolution.truncated, candidates };
}
