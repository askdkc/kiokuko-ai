import type { EntryRecord } from './entries.js';

const ABSOLUTE_PATH = /(?:\/(?:Users|home|private|workspace|tmp|var|opt)\/|[A-Za-z]:[\\/])/u;
const PROJECT_RELATIVE_PATH = /(?:^|[^\p{L}\p{N}_.-])(?:\.[\\/])?(?:src|tests?|app|lib|packages?|config|resources|migrations|scripts?|docs?|\.github)[\\/][A-Za-z0-9_.@/\\-]+/u;
const PROJECT_LANGUAGE = /(?:この(?:リポジトリ|プロジェクト)|当(?:リポジトリ|プロジェクト)|本プロジェクト|this (?:repository|project)|the current repository|the current project|project-specific|project:|repo_[a-z0-9_-]+)/iu;

export type PortableEntryFields = Pick<
  EntryRecord,
  'workspace' | 'title' | 'summary' | 'body' | 'tags' | 'scope' | 'provenance'
>;

export interface PortabilityAnalysis {
  portable: boolean;
  projectSpecific: boolean;
  reasons: string[];
}

function knownProjectValues(entry: Pick<EntryRecord, 'workspace' | 'scope' | 'provenance'>): string[] {
  const scope = entry.scope as Record<string, unknown>;
  const provenance = entry.provenance as Record<string, unknown>;
  const values: unknown[] = [entry.workspace, scope.repositoryId, provenance.sourceWorkspace, provenance.sourceRepositoryId];
  if (Array.isArray(provenance.sourcePaths)) values.push(...provenance.sourcePaths);
  return [...new Set(values.filter((value): value is string => typeof value === 'string' && value.length >= 3))]
    .sort((left, right) => right.length - left.length);
}

function structuredPathSignals(entry: Pick<EntryRecord, 'scope'>): string[] {
  const signals = (entry.scope as Record<string, unknown>).signals;
  if (typeof signals !== 'object' || signals === null || Array.isArray(signals)) return [];
  const paths = (signals as Record<string, unknown>).paths;
  return Array.isArray(paths) ? paths.filter((value): value is string => typeof value === 'string') : [];
}

export function analyzePortability(entry: PortableEntryFields): PortabilityAnalysis {
  const text = [entry.title, entry.summary ?? '', entry.body, ...entry.tags, ...structuredPathSignals(entry)].join('\n').normalize('NFKC');
  const reasons: string[] = [];
  if (knownProjectValues(entry).some((value) => text.includes(value.normalize('NFKC')))) reasons.push('project-identifier');
  if (ABSOLUTE_PATH.test(text)) reasons.push('absolute-path');
  if (PROJECT_RELATIVE_PATH.test(text)) reasons.push('project-relative-path');
  if (PROJECT_LANGUAGE.test(text)) reasons.push('project-specific-language');
  const sourcePaths = (entry.provenance as Record<string, unknown>).sourcePaths;
  if (Array.isArray(sourcePaths) && sourcePaths.length > 0) reasons.push('provenance-source-path');
  return { portable: reasons.length === 0, projectSpecific: reasons.length > 0, reasons };
}

export function containsProjectSpecificData(value: string, entry: Pick<EntryRecord, 'workspace' | 'scope' | 'provenance'>): boolean {
  const text = value.normalize('NFKC');
  const values = knownProjectValues(entry);
  return values.some((known) => text.includes(known.normalize('NFKC')))
    || ABSOLUTE_PATH.test(text)
    || PROJECT_RELATIVE_PATH.test(text)
    || PROJECT_LANGUAGE.test(text);
}
