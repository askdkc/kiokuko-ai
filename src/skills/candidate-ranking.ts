import type { SkillCandidate, SkillRequirement } from './types.js';
import type { TaskProfile } from '../akinator/types.js';
import { compareCanonicalStrings } from '../serialization/validate.js';

export interface RankedSkillCandidate {
  candidate: SkillCandidate;
  score: number;
  reasons: string[];
}

function norm(value: string): string { return value.normalize('NFKC').toLowerCase(); }

const GENERIC_CANDIDATE_TOKENS = new Set(['best', 'code', 'guide', 'guidance', 'helper', 'practice', 'practices', 'skill', 'tools', 'writer']);

function tokens(value: string): Set<string> {
  return new Set((norm(value).match(/[\p{L}\p{N}][\p{L}\p{N}.-]*/gu) ?? [])
    .flatMap((token) => token.split(/[.-]/u))
    .filter((token) => token.length > 2));
}

function isTaskRelevant(candidate: SkillCandidate, requirement: SkillRequirement, task: string, profile: TaskProfile): boolean {
  const scopeTokens = tokens([task, profile.target ?? '', profile.expected ?? '', profile.constraints ?? ''].join(' '));
  const requirementTokens = tokens([requirement.id, requirement.technology, ...requirement.aliases].join(' '));
  const candidateTokens = tokens(`${candidate.name} ${candidate.slug}`);
  return [...candidateTokens].some((token) => !requirementTokens.has(token) && !GENERIC_CANDIDATE_TOKENS.has(token) && scopeTokens.has(token));
}

export function rankSkillCandidates(input: { candidates: SkillCandidate[]; requirement: SkillRequirement; task: string; profile: TaskProfile; mode?: 'official' | 'community' }): RankedSkillCandidate[] {
  return input.candidates.map((candidate) => {
    const reasons: string[] = [];
    const source = norm(candidate.source);
    const exactRepository = input.requirement.repositories.some((repository) => norm(repository) === source);
    const ownerMatch = input.requirement.owners.some((owner) => source.startsWith(`${norm(owner)}/`));
    const exactTechnology = [candidate.name, candidate.slug].some((value) => input.requirement.aliases.some((alias) => norm(value) === norm(alias)));
    const taskRelevance = isTaskRelevant(candidate, input.requirement, input.task, input.profile);
    if (exactRepository) reasons.push('exact_repository');
    if (candidate.officialStatus === 'curated') reasons.push('curated_first_party');
    if (candidate.officialStatus === 'catalog-verified') reasons.push('catalog_verified');
    if (ownerMatch || candidate.officialStatus === 'owner-verified') reasons.push('official_owner');
    if (exactTechnology) reasons.push('exact_technology');
    if (taskRelevance) reasons.push('task_relevance');
    if (candidate.auditStatus === 'passed') reasons.push('audit_passed');
    if (!candidate.duplicate) reasons.push('not_duplicate');
    const score = (exactRepository ? 1000 : 0)
      + (candidate.officialStatus === 'curated' ? 800 : 0)
      + (candidate.officialStatus === 'catalog-verified' ? 750 : 0)
      + (ownerMatch || candidate.officialStatus === 'owner-verified' ? 600 : 0)
      + (exactTechnology ? 300 : 0)
      + (taskRelevance ? 100 : 0)
      + (candidate.auditStatus === 'passed' ? 50 : 0)
      + (candidate.duplicate ? -1000 : 0)
      + Math.log1p(Math.max(0, candidate.installs));
    return { candidate, score, reasons };
  }).filter((item) => input.mode === 'community' || ['curated', 'catalog-verified', 'owner-verified'].includes(item.candidate.officialStatus))
    .sort((left, right) => right.score - left.score || compareCanonicalStrings(left.candidate.id, right.candidate.id));
}
