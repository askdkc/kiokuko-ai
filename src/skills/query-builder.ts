import type { TaskProfile } from '../akinator/types.js';
import { KiokukoError } from '../errors.js';
import { findSecret } from '../memory/secrets.js';
import { OFFICIAL_TECHNOLOGIES, technologyDefinition } from './official-catalog.js';
import type { SkillRequirement } from './types.js';

export const MAX_QUERIES_PER_TASK = 3;
export const MAX_QUERY_CHARS = 80;
export const MIN_QUERY_CHARS = 2;
export const MAX_SEARCH_RESULTS = 20;

const TASK_SUFFIXES = new Map<string, string>([
  ['build', 'testing'],
  ['debug', 'debug'],
  ['review', 'review'],
]);

function normalize(value: string): string {
  return value.normalize('NFKC').toLowerCase().replace(/\s+/gu, ' ').trim();
}

const CATALOG_QUERIES = new Set(OFFICIAL_TECHNOLOGIES.flatMap((definition) => [definition.id, ...definition.queries]).map(normalize));
const ALLOWED_QUERIES = new Set([
  ...CATALOG_QUERIES,
  ...OFFICIAL_TECHNOLOGIES.flatMap((definition) => [...TASK_SUFFIXES.values()].map((suffix) => `${normalize(definition.id)} ${suffix}`)),
]);
const VERIFIED_OWNERS = new Set(OFFICIAL_TECHNOLOGIES.flatMap((definition) => definition.owners).map(normalize));

function sameNormalizedSet(actual: string[], expected: string[]): boolean {
  const left = [...new Set(actual.map(normalize))].sort();
  const right = [...new Set(expected.map(normalize))].sort();
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function validatedDefinition(requirement: SkillRequirement) {
  const definition = technologyDefinition(normalize(requirement.id));
  if (definition === undefined
    || normalize(requirement.technology) !== normalize(definition.id)
    || !sameNormalizedSet(requirement.queries, definition.queries)
    || !sameNormalizedSet(requirement.owners, definition.owners)
    || !sameNormalizedSet(requirement.repositories, definition.repositories)) {
    throw new KiokukoError('VALIDATION_ERROR', 'Skill requirement is not from the official catalog');
  }
  for (const query of requirement.queries) validateSkillQuery(query);
  for (const owner of requirement.owners) validateSkillOwner(owner);
  return definition;
}

export function buildSkillQueries(input: { requirements: SkillRequirement[]; profile?: TaskProfile; mode?: 'official' | 'community' }): string[] {
  const queries: string[] = [];
  for (const requirement of input.requirements) {
    const definition = validatedDefinition(requirement);
    for (const query of definition.queries) queries.push(validateSkillQuery(query));
    const suffix = input.profile?.taskType === null || input.profile?.taskType === undefined
      ? undefined
      : TASK_SUFFIXES.get(input.profile.taskType);
    if (suffix !== undefined) queries.push(validateSkillQuery(`${definition.id} ${suffix}`));
  }
  return [...new Set(queries)].slice(0, MAX_QUERIES_PER_TASK);
}

export function validateSkillQuery(value: unknown): string {
  if (typeof value !== 'string') throw new KiokukoError('VALIDATION_ERROR', 'Skill query is invalid');
  const secret = findSecret(value);
  if (secret) throw new KiokukoError('SECURITY_REJECTION', 'Skill query resembles a secret and was not sent', { kind: secret.kind });
  if (/[\\/]/u.test(value) || value.includes('..')) throw new KiokukoError('VALIDATION_ERROR', 'Skill query is invalid');
  const query = normalize(value);
  if (query.length < MIN_QUERY_CHARS || query.length > MAX_QUERY_CHARS || !ALLOWED_QUERIES.has(query)) throw new KiokukoError('VALIDATION_ERROR', 'Skill query is invalid');
  return query;
}

export function validateSkillOwner(value: unknown): string {
  if (typeof value !== 'string') throw new KiokukoError('VALIDATION_ERROR', 'Skill owner is invalid');
  const secret = findSecret(value);
  if (secret) throw new KiokukoError('SECURITY_REJECTION', 'Skill owner resembles a secret and was not sent', { kind: secret.kind });
  const owner = normalize(value);
  if (!/^[a-z0-9_.-]{1,100}$/u.test(owner) || owner === '.' || owner === '..' || !VERIFIED_OWNERS.has(owner)) throw new KiokukoError('VALIDATION_ERROR', 'Skill owner is invalid');
  return owner;
}

export function validateSkillSearchScope(queryValue: unknown, ownerValue?: unknown): { query: string; owner?: string } {
  const query = validateSkillQuery(queryValue);
  if (ownerValue === undefined) return { query };
  const owner = validateSkillOwner(ownerValue);
  const matchingDefinitions = OFFICIAL_TECHNOLOGIES.filter((definition) => {
    const id = normalize(definition.id);
    return definition.queries.map(normalize).includes(query) || query === id || [...TASK_SUFFIXES.values()].some((suffix) => query === `${id} ${suffix}`);
  });
  if (!matchingDefinitions.some((definition) => definition.owners.map(normalize).includes(owner))) throw new KiokukoError('VALIDATION_ERROR', 'Skill owner is invalid for the query');
  return { query, owner };
}
