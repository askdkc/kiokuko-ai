import type { ProjectFingerprint } from '../repository/project-fingerprint.js';
import { compareCanonicalStrings } from '../serialization/validate.js';
import type { SkillCandidate, SkillRequirement } from './types.js';

export interface OfficialTechnologyDefinition {
  id: string;
  aliases: string[];
  fuzzyAliases?: string[];
  applicableLanguages?: string[];
  applicableRuntimes?: string[];
  applicableDatabases?: string[];
  packages: string[];
  frameworks: string[];
  owners: string[];
  repositories: string[];
  /** Exact provider candidate identities and primary paths reviewed for source validation. */
  reviewedSkills?: Array<{ slug: string; primaryPaths: string[] }>;
  queries: string[];
}

export const OFFICIAL_TECHNOLOGIES: readonly OfficialTechnologyDefinition[] = [
  { id: 'svelte', aliases: ['svelte'], fuzzyAliases: ['svelte'], applicableLanguages: ['JavaScript', 'TypeScript'], applicableRuntimes: ['Node.js'], packages: ['svelte'], frameworks: ['Svelte'], owners: ['sveltejs'], repositories: ['sveltejs/ai-tools'], reviewedSkills: [{ slug: 'svelte-code-writer', primaryPaths: ['skills/svelte-code-writer/SKILL.md', 'tools/skills/svelte-code-writer/SKILL.md'] }], queries: ['svelte'] },
  { id: 'sveltekit', aliases: ['sveltekit', 'svelte'], fuzzyAliases: ['sveltekit', 'svelte'], applicableLanguages: ['JavaScript', 'TypeScript'], applicableRuntimes: ['Node.js'], packages: ['@sveltejs/kit'], frameworks: ['SvelteKit'], owners: ['sveltejs'], repositories: ['sveltejs/ai-tools'], reviewedSkills: [{ slug: 'svelte-code-writer', primaryPaths: ['skills/svelte-code-writer/SKILL.md', 'tools/skills/svelte-code-writer/SKILL.md'] }], queries: ['sveltekit', 'svelte'] },
  { id: 'laravel', aliases: ['laravel'], fuzzyAliases: ['laravel'], applicableLanguages: ['PHP'], applicableRuntimes: ['PHP'], packages: ['laravel/framework'], frameworks: ['Laravel'], owners: ['laravel'], repositories: ['laravel/boost'], reviewedSkills: [{ slug: 'laravel-best-practices', primaryPaths: ['.ai/laravel/skill/laravel-best-practices/SKILL.md'] }], queries: ['laravel', 'laravel testing'] },
  // Upstream framework repositories are not automatically Skill repositories.
  // Keep their verified owners for scoped search, but add a reviewed repository
  // only after its SKILL.md layout has a fixture and has been reviewed.
  { id: 'react', aliases: ['react'], fuzzyAliases: ['react'], applicableLanguages: ['JavaScript', 'TypeScript'], applicableRuntimes: ['Node.js'], packages: ['react'], frameworks: ['React'], owners: ['facebook'], repositories: [], queries: ['react'] },
  { id: 'nextjs', aliases: ['next', 'nextjs'], fuzzyAliases: ['nextjs'], applicableLanguages: ['JavaScript', 'TypeScript'], applicableRuntimes: ['Node.js'], packages: ['next'], frameworks: ['Next.js'], owners: ['vercel'], repositories: [], queries: ['nextjs', 'react'] },
  { id: 'postgresql', aliases: ['postgres', 'postgresql'], fuzzyAliases: ['postgresql'], applicableDatabases: ['PostgreSQL'], packages: ['pg'], frameworks: [], owners: ['postgres'], repositories: [], queries: ['postgresql'] },
  { id: 'mysql', aliases: ['mysql'], fuzzyAliases: ['mysql'], applicableDatabases: ['MySQL'], packages: ['mysql2'], frameworks: [], owners: ['mysql'], repositories: [], queries: ['mysql'] },
  { id: 'sqlite', aliases: ['sqlite'], fuzzyAliases: ['sqlite'], applicableDatabases: ['SQLite'], packages: ['sqlite3', 'better-sqlite3'], frameworks: [], owners: ['sqlite'], repositories: [], queries: ['sqlite'] },
  { id: 'typescript', aliases: ['typescript'], fuzzyAliases: ['typescript'], applicableLanguages: ['TypeScript'], applicableRuntimes: ['Node.js'], packages: ['typescript'], frameworks: [], owners: ['microsoft'], repositories: [], queries: ['typescript'] },
  { id: 'python', aliases: ['python'], fuzzyAliases: ['python'], applicableLanguages: ['Python'], applicableRuntimes: ['Python'], packages: [], frameworks: [], owners: ['python'], repositories: [], queries: ['python'] },
  { id: 'go', aliases: ['go', 'golang'], fuzzyAliases: ['golang'], applicableLanguages: ['Go'], applicableRuntimes: ['Go'], packages: [], frameworks: [], owners: ['golang'], repositories: [], queries: ['go'] },
  { id: 'rust', aliases: ['rust'], fuzzyAliases: ['rust'], applicableLanguages: ['Rust'], applicableRuntimes: ['Rust'], packages: [], frameworks: [], owners: ['rust-lang'], repositories: [], queries: ['rust'] },
];

function unique<T>(values: T[]): T[] { return [...new Set(values)]; }
function norm(value: string): string { return value.normalize('NFKC').toLowerCase(); }
function matches(value: string, candidates: string[]): boolean { const current = norm(value); return candidates.some((candidate) => norm(candidate) === current); }

function matchingValues(targets: string[] | undefined, actual: string[]): string[] | undefined {
  if (targets === undefined) return undefined;
  const values = targets.filter((target) => actual.some((value) => matches(value, [target])));
  return values.length > 0 ? values : undefined;
}

function applicability(definition: OfficialTechnologyDefinition, fingerprint: ProjectFingerprint) {
  const languages = matchingValues(definition.applicableLanguages, fingerprint.languages);
  const runtimes = matchingValues(definition.applicableRuntimes, fingerprint.runtimes);
  const frameworks = fingerprint.frameworks.filter((item) => definition.frameworks.some((name) => matches(item.name, [name])));
  const databases = matchingValues(definition.applicableDatabases, fingerprint.databases);
  return {
    ...(languages === undefined ? {} : { languages }),
    ...(runtimes === undefined ? {} : { runtimes }),
    ...(frameworks.length > 0 ? { frameworks } : definition.frameworks.length > 0 ? { frameworks: definition.frameworks.map((name) => ({ name })) } : {}),
    ...(databases === undefined ? {} : { databases }),
  };
}

export function technologyDefinition(id: string): OfficialTechnologyDefinition | undefined {
  return OFFICIAL_TECHNOLOGIES.find((item) => item.id === id);
}

export const OFFICIAL_SKILL_REPOSITORIES = unique(OFFICIAL_TECHNOLOGIES.flatMap((definition) => definition.repositories));

export function reviewedCatalogSkill(candidate: Pick<SkillCandidate, 'source' | 'slug'>): { slug: string; primaryPaths: string[] } | undefined {
  const matches = OFFICIAL_TECHNOLOGIES.flatMap((definition) =>
    definition.repositories.some((repository) => norm(repository) === norm(candidate.source))
      ? (definition.reviewedSkills ?? []).filter((skill) => skill.slug === candidate.slug)
      : []);
  if (matches.length === 0) return undefined;
  const first = matches[0]!;
  const primaryPaths = unique(matches.flatMap((match) => match.primaryPaths));
  return { slug: first.slug, primaryPaths };
}

function genericApplicability(definition: OfficialTechnologyDefinition): SkillRequirement['applicability'] {
  return {
    ...(definition.applicableLanguages === undefined ? {} : { languages: [...definition.applicableLanguages] }),
    ...(definition.applicableRuntimes === undefined ? {} : { runtimes: [...definition.applicableRuntimes] }),
    ...(definition.frameworks.length === 0 ? {} : { frameworks: definition.frameworks.map((name) => ({ name })) }),
    ...(definition.applicableDatabases === undefined ? {} : { databases: [...definition.applicableDatabases] }),
  };
}

/** Resolve only repository identities already pinned in Kiokuko's local catalog. */
export function requirementForOfficialSkill(candidate: Pick<SkillCandidate, 'source' | 'slug' | 'name'>): SkillRequirement | undefined {
  const definitions = OFFICIAL_TECHNOLOGIES.filter((definition) =>
    definition.repositories.some((repository) => norm(repository) === norm(candidate.source))
    && (definition.reviewedSkills ?? []).some((skill) => skill.slug === candidate.slug));
  if (definitions.length === 0) return undefined;
  const tokens = new Set(norm(`${candidate.slug} ${candidate.name}`).split(/[^\p{L}\p{N}]+/u).filter(Boolean));
  const definition = [...definitions].sort((left, right) => {
    const score = (item: OfficialTechnologyDefinition) => (tokens.has(norm(item.id)) ? 10 : 0) + item.aliases.filter((alias) => tokens.has(norm(alias))).length;
    return score(right) - score(left) || right.id.length - left.id.length || compareCanonicalStrings(left.id, right.id);
  })[0]!;
  return {
    id: definition.id,
    technology: definition.id,
    aliases: unique([definition.id, ...definition.aliases, ...definition.frameworks]),
    ...(definition.fuzzyAliases === undefined ? {} : { fuzzyAliases: unique(definition.fuzzyAliases) }),
    queries: unique(definition.queries),
    owners: unique(definition.owners),
    repositories: unique(definition.repositories),
    applicability: genericApplicability(definition),
    signals: definition.packages.length > 0 ? { packages: [...definition.packages] } : {},
    reason: `Local official catalog matched ${candidate.source}.`,
  };
}

export function requirementsFromFingerprint(fingerprint: ProjectFingerprint): SkillRequirement[] {
  const packageNames = fingerprint.packages.map((item) => item.name);
  const definitions = OFFICIAL_TECHNOLOGIES.filter((definition) =>
    definition.packages.some((name) => packageNames.includes(name))
    || definition.frameworks.some((name) => fingerprint.frameworks.some((framework) => matches(framework.name, [name])))
    || definition.id === 'typescript' && fingerprint.tools.some((tool) => norm(tool) === 'typescript')
    || definition.id === 'python' && fingerprint.languages.includes('Python')
    || definition.id === 'go' && fingerprint.languages.includes('Go')
    || definition.id === 'rust' && fingerprint.languages.includes('Rust')
    || definition.id === 'postgresql' && fingerprint.databases.includes('PostgreSQL')
    || definition.id === 'mysql' && fingerprint.databases.includes('MySQL')
    || definition.id === 'sqlite' && fingerprint.databases.includes('SQLite'));
  return definitions.map((definition) => ({
    id: definition.id,
    technology: definition.id,
    aliases: unique([definition.id, ...definition.aliases, ...definition.frameworks]),
    ...(definition.fuzzyAliases === undefined ? {} : { fuzzyAliases: unique(definition.fuzzyAliases) }),
    queries: unique(definition.queries),
    owners: unique(definition.owners),
    repositories: unique(definition.repositories),
    applicability: applicability(definition, fingerprint),
    signals: definition.packages.length > 0 ? { packages: [...definition.packages] } : {},
    reason: `Project fingerprint detected ${definition.id}.`,
  }));
}
