import type { SqliteDatabase, SqliteRow } from '../db/adapter.js';
import { normalizeCapabilityCatalog } from '../akinator/capabilities.js';
import {
  STANDARD_FUNCTION_SKILL_NAME,
  STANDARD_SOUL_SKILL_NAME,
  STANDARD_UI_SKILL_NAME,
} from '../setup/standard-skills.js';
import type { SkillDiscoverySummary } from '../skills/types.js';
import type { SkillPurpose, SkillSetEntry } from './types.js';

export interface RequestedSkill {
  name: string;
  purposes: SkillPurpose[];
  required: boolean;
}

function normalize(value: string): string {
  return value.normalize('NFKC').toLowerCase().replaceAll('_', '-');
}

function mergedRequirement(existing: RequestedSkill | undefined, next: RequestedSkill): RequestedSkill {
  if (existing === undefined) return { ...next, purposes: [...new Set(next.purposes)] };
  return {
    name: existing.name,
    purposes: [...new Set([...existing.purposes, ...next.purposes])],
    required: existing.required || next.required,
  };
}

export function orderedUniqueSkillNames(...groups: readonly (readonly string[])[]): string[] {
  const seen = new Set<string>();
  const ordered: string[] = [];
  for (const group of groups) {
    for (const name of group) {
      const key = normalize(name);
      if (seen.has(key)) continue;
      seen.add(key);
      ordered.push(name);
    }
  }
  return ordered;
}

export function completeRequiredSkillList(input: {
  requested: readonly RequestedSkill[];
  includesCodeChanges: boolean;
  includesUiWork: boolean;
}): RequestedSkill[] {
  const byName = new Map<string, RequestedSkill>();
  const soul: RequestedSkill = {
    name: STANDARD_SOUL_SKILL_NAME,
    purposes: ['planning', 'implementation', 'ui', 'testing', 'review', 'operations'],
    required: true,
  };
  byName.set(normalize(soul.name), soul);
  if (input.includesCodeChanges) {
    const required: RequestedSkill = {
      name: STANDARD_FUNCTION_SKILL_NAME,
      purposes: ['implementation', 'testing', 'review'],
      required: true,
    };
    const key = normalize(required.name);
    byName.set(key, mergedRequirement(byName.get(key), required));
  }
  if (input.includesUiWork) {
    const required: RequestedSkill = {
      name: STANDARD_UI_SKILL_NAME,
      purposes: ['ui', 'testing', 'review'],
      required: true,
    };
    const key = normalize(required.name);
    byName.set(key, mergedRequirement(byName.get(key), required));
  }
  for (const requirement of input.requested) {
    const key = normalize(requirement.name);
    byName.set(key, mergedRequirement(byName.get(key), requirement));
  }
  return [...byName.values()];
}

interface ExternalSkillRow extends SqliteRow {
  skillId: string;
  name: string;
  state: string;
  sourceCommit: string | null;
  snapshotHash: string | null;
  lastCheckedAt: string;
}

function readMatchingExternalSkill(database: SqliteDatabase, name: string): ExternalSkillRow | undefined {
  return database.prepare(`
    SELECT skill_id AS skillId, name, state,
           source_commit AS sourceCommit, snapshot_hash AS snapshotHash,
           last_checked_at AS lastCheckedAt
    FROM external_skills
    WHERE lower(name) = lower(?)
    ORDER BY CASE state WHEN 'imported' THEN 0 WHEN 'discovered' THEN 1 ELSE 2 END,
             last_checked_at DESC, skill_id ASC
    LIMIT 1
  `).get<ExternalSkillRow>(name);
}

function isFreshImported(row: ExternalSkillRow, now: number): boolean {
  if (row.state !== 'imported' || row.sourceCommit === null || row.snapshotHash === null) return false;
  const checked = Date.parse(row.lastCheckedAt);
  return Number.isFinite(checked) && checked <= now && now - checked < 7 * 24 * 60 * 60_000;
}

export function createSkillSetEntries(database: SqliteDatabase, input: {
  requirements: readonly RequestedSkill[];
  capabilities?: unknown;
  discoveries: readonly SkillDiscoverySummary[];
  now?: number;
}): SkillSetEntry[] {
  const catalog = normalizeCapabilityCatalog(input.capabilities);
  const localByName = new Map(catalog.skills.map((skill) => [normalize(skill.name), skill.name]));
  const exactLocalSoul = catalog.skills.find((skill) => skill.name.normalize('NFKC').toLowerCase() === STANDARD_SOUL_SKILL_NAME)?.name;
  const soulKey = normalize(STANDARD_SOUL_SKILL_NAME);
  const discovered = input.discoveries.flatMap((summary) => summary.selected);
  const now = input.now ?? Date.now();
  return input.requirements.map((requirement) => {
    if (normalize(requirement.name) === soulKey) {
      return exactLocalSoul === undefined
        ? { ...requirement, availability: 'unavailable' as const, referenceId: null }
        : { ...requirement, name: exactLocalSoul, availability: 'local' as const, referenceId: null };
    }
    const local = localByName.get(normalize(requirement.name));
    if (local !== undefined) {
      return { ...requirement, name: local, availability: 'local' as const, referenceId: null };
    }
    const persisted = readMatchingExternalSkill(database, requirement.name);
    if (persisted !== undefined && isFreshImported(persisted, now)) {
      return {
        ...requirement,
        availability: 'imported_fresh' as const,
        referenceId: persisted.skillId,
      };
    }
    const reference = discovered.find((candidate) => normalize(candidate.name) === normalize(requirement.name));
    if (reference !== undefined) {
      return {
        ...requirement,
        availability: reference.imported ? 'imported_fresh' as const : 'external_reference' as const,
        referenceId: reference.skillId,
      };
    }
    if (persisted !== undefined && persisted.state === 'discovered') {
      return {
        ...requirement,
        availability: 'external_reference' as const,
        referenceId: persisted.skillId,
      };
    }
    return { ...requirement, availability: 'unavailable' as const, referenceId: null };
  });
}

export function unavailableRequiredSkills(entries: readonly SkillSetEntry[]): SkillSetEntry[] {
  return entries.filter((entry) => entry.required
    && entry.availability !== 'local'
    && entry.availability !== 'imported_fresh');
}
