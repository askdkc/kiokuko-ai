import type { TaskProfile } from '../akinator/types.js';
import { normalizeCapabilityCatalog, type CapabilityDescriptor } from '../akinator/capabilities.js';
import type { ProjectFingerprint } from '../repository/project-fingerprint.js';
import { requirementsFromFingerprint } from './official-catalog.js';
import type { SkillRequirement } from './types.js';

export interface SkillGapDecision {
  requirements: SkillRequirement[];
  available: Array<{ requirementId: string; capabilityName: string }>;
  missing: SkillRequirement[];
  catalogAvailability: 'known-empty' | 'known-nonempty' | 'unknown';
  shouldDiscover: boolean;
  reason: 'relevant_skill_missing' | 'availability_unknown' | 'all_relevant_skills_available' | 'no_supported_technology' | 'discovery_disabled';
}

function norm(value: string): string { return value.normalize('NFKC').toLowerCase().replaceAll('_', '-'); }
function tokens(value: string): Set<string> { return new Set((value.toLowerCase().match(/[\p{L}\p{N}][\p{L}\p{N}.-]*/gu) ?? []).map(norm)); }
function containsAlias(value: string, alias: string): boolean {
  const escaped = alias.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
  return new RegExp(`(?:^|[^\\p{L}\\p{N}])${escaped}(?:$|[^\\p{L}\\p{N}])`, 'iu').test(value);
}

const NON_CODE_TASK_SCOPE = /(?:\breadme(?:\.md)?\b|\b(?:change\s*log|changelog|copy|grammar|license|prose|spelling|translation|typo|wording)\b|お知らせ|コピー|翻訳|文言|誤字|脱字)/iu;

// A verified namespace identifies provenance, not the technology it supports.
function containsQualifiedAlias(value: string, qualifier: string, requirementAliases: string[]): boolean {
  const escaped = norm(qualifier).replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
  const match = new RegExp(`^${escaped}([/:].+)$`, 'u').exec(norm(value));
  return match !== null && requirementAliases.some((alias) => containsAlias(match[1]!, norm(alias)));
}

function requirementRelevant(requirement: SkillRequirement, task: string, profile: TaskProfile, recommendedTags: string[], all: SkillRequirement[]): boolean {
  const text = `${task} ${profile.target ?? ''} ${profile.expected ?? ''} ${profile.constraints ?? ''} ${recommendedTags.join(' ')}`;
  const taskTokens = tokens(text);
  const aliasesForRequirement = requirement.aliases.map(norm);
  const explicitlyNamed = aliasesForRequirement.some((alias) => containsAlias(text, alias));
  if (explicitlyNamed) return true;
  const otherNamed = all.some((candidate) => candidate !== requirement && candidate.aliases.some((alias) => containsAlias(text, norm(alias))));
  if (otherNamed) return false;
  if (NON_CODE_TASK_SCOPE.test(text)) return false;
  return profile.taskType === 'build' || profile.taskType === 'debug' || taskTokens.size === 0;
}

function matchesRequirement(capability: CapabilityDescriptor, requirement: SkillRequirement): boolean {
  if (capability.kind !== 'skill') return false;
  const name = norm(capability.name);
  if (requirement.aliases.some((alias) => name === norm(alias))) return true;
  const fuzzyAliases = requirement.fuzzyAliases ?? [];
  const unqualifiedName = !/[/:]/u.test(name);
  return unqualifiedName && fuzzyAliases.some((alias) => containsAlias(name, norm(alias)))
    || [...requirement.repositories, ...requirement.owners]
      .some((qualifier) => containsQualifiedAlias(name, qualifier, requirement.aliases));
}

export function detectSkillGap(input: {
  fingerprint: ProjectFingerprint;
  task: string;
  profile: TaskProfile;
  capabilities?: unknown;
  recommendedTags?: string[];
  mode?: 'off' | 'official' | 'community';
}): SkillGapDecision {
  const all = requirementsFromFingerprint(input.fingerprint);
  const requirements = all.filter((requirement) => requirementRelevant(requirement, input.task, input.profile, input.recommendedTags ?? [], all));
  const catalog = normalizeCapabilityCatalog(input.capabilities);
  if (input.mode === 'off') return { requirements, available: [], missing: [], catalogAvailability: catalog.availability, shouldDiscover: false, reason: 'discovery_disabled' };
  if (requirements.length === 0) return { requirements, available: [], missing: [], catalogAvailability: catalog.availability, shouldDiscover: false, reason: 'no_supported_technology' };
  const available: SkillGapDecision['available'] = [];
  const missing: SkillRequirement[] = [];
  for (const requirement of requirements) {
    const capability = catalog.skills.find((item) => matchesRequirement(item, requirement));
    if (capability) available.push({ requirementId: requirement.id, capabilityName: capability.name });
    else missing.push(requirement);
  }
  const reason = catalog.availability === 'unknown' ? 'availability_unknown' : missing.length > 0 ? 'relevant_skill_missing' : 'all_relevant_skills_available';
  return { requirements, available, missing, catalogAvailability: catalog.availability, shouldDiscover: reason !== 'all_relevant_skills_available', reason };
}
