import { Command, Option } from 'commander';
import { readSkillDiscoveryConfig } from '../skills/config.js';
import { GitHubSkillSourceFetcher } from '../skills/source/github-fetcher.js';
import { SkillSourceError, type SkillSourceFailureCode } from '../skills/source/errors.js';
import { externalSkillRequirement, externalSkillSourceFetchRequest, importSkillSnapshot, listExternalSkills, markExternalSkillRefreshFailure, parseExternalSkillLocator, pruneExternalSkillCaches, readExternalSkill, refreshExternalSkillSnapshot, resolveExternalSkillIdentifier, setExternalSkillState, type ExternalSkillRefreshResult } from '../skills/store.js';
import { documentsFromSkillSnapshot } from '../skills/import-preparation.js';
import type { SkillCandidate, SkillRegistryProvider } from '../skills/types.js';
import type { SqliteDatabase } from '../db/adapter.js';
import { KiokukoError } from '../errors.js';
import { successEnvelope } from '../serialization/envelope.js';
import { requirementForOfficialSkill } from '../skills/official-catalog.js';
import { createSkillRegistryProvider, findSkills } from '../skills/find.js';
import { SkillProviderError } from '../skills/providers/schema.js';
import { fetchMaterializableSkillSnapshot } from '../skills/materialization-service.js';

export interface SkillsCommandDependencies {
  withDatabase: <T>(operation: (database: SqliteDatabase) => T | Promise<T>) => Promise<T>;
  provider?: SkillRegistryProvider;
}
const EXTERNAL_SKILL_STATES = ['discovered', 'imported', 'blocked', 'stale', 'disabled'] as const;
const MAX_REFRESH_FAILURE_DETAILS = 20;
interface RefreshFailure { skillId: string; code: SkillSourceFailureCode; }
interface RefreshProgress {
  attempted: number;
  completed: number;
  succeeded: number;
  staled: number;
  committed: number;
  failed: number;
  remaining: number;
}

function candidateFromIdentifier(identifier: string): SkillCandidate {
  const { source, slug } = parseExternalSkillLocator(identifier);
  const provider = 'kiokuko-reviewed-catalog';
  const candidate: SkillCandidate = { id: `${provider}:${source}:${slug}`, provider, name: slug.split('/').at(-1)!, slug, source, sourceType: 'github', installUrl: `https://github.com/${source}`, installs: 0, duplicate: false, officialStatus: 'unknown' };
  return requirementForOfficialSkill(candidate) ? { ...candidate, officialStatus: 'catalog-verified' } : candidate;
}
function declaredSkillSourceFailureCode(error: SkillSourceError): SkillSourceFailureCode | undefined {
  const code: unknown = error.code;
  switch (code) {
    case 'source_missing':
    case 'source_rate_limited':
    case 'source_unavailable':
    case 'candidate_not_found_at_source':
    case 'source_tree_truncated':
    case 'skill_disabled_for_model_invocation':
    case 'skill_secret_detected':
    case 'skill_too_large':
    case 'skill_validation_failed':
    case 'skill_blocked':
      return code;
    default:
      return undefined;
  }
}
function refreshFailureState(code: SkillSourceFailureCode): 'stale' | 'blocked' | null {
  if (code === 'source_missing' || code === 'candidate_not_found_at_source') return 'stale';
  if (code === 'skill_disabled_for_model_invocation' || code === 'skill_secret_detected' || code === 'skill_blocked') return 'blocked';
  return null;
}
function emit(json: boolean | undefined, operation: string, data: unknown, message: string): void { process.stdout.write(json ? `${JSON.stringify(successEnvelope(operation, data))}\n` : `${message}\n`); }

function withExactCause(error: KiokukoError, cause: unknown): KiokukoError {
  Object.defineProperty(error, 'cause', {
    value: cause,
    enumerable: false,
    configurable: false,
    writable: false,
  });
  return error;
}

function publicSkillSourceError(error: SkillSourceError): KiokukoError {
  const details = {
    failureCode: error.code,
    ...(error.retryAfterSeconds === null ? {} : { retryAfterSeconds: error.retryAfterSeconds }),
  };
  switch (error.code) {
    case 'source_missing':
    case 'candidate_not_found_at_source':
      return withExactCause(new KiokukoError('NOT_FOUND', 'External skill source was not found', details), error);
    case 'source_rate_limited':
    case 'source_unavailable':
      return withExactCause(new KiokukoError('SERVICE_UNAVAILABLE', 'External skill source is temporarily unavailable', details), error);
    case 'source_tree_truncated':
    case 'skill_disabled_for_model_invocation':
    case 'skill_secret_detected':
    case 'skill_too_large':
    case 'skill_validation_failed':
    case 'skill_blocked':
      return withExactCause(new KiokukoError('SECURITY_REJECTION', 'External skill source failed validation', details), error);
    default:
      throw error;
  }
}

function publicSkillProviderError(error: SkillProviderError): KiokukoError {
  const details = {
    failureCode: error.code,
    ...(error.retryAfterSeconds === null ? {} : { retryAfterSeconds: error.retryAfterSeconds }),
  };
  switch (error.code) {
    case 'registry_authentication_failed':
      return withExactCause(new KiokukoError('AUTHENTICATION_ERROR', 'External skill registry authentication failed', details), error);
    case 'registry_unavailable':
    case 'registry_rate_limited':
      return withExactCause(new KiokukoError('SERVICE_UNAVAILABLE', 'External skill registry is temporarily unavailable', details), error);
    case 'registry_invalid_response':
      return withExactCause(new KiokukoError('INTEGRITY_ERROR', 'External skill registry returned an invalid response', details), error);
    default:
      throw error;
  }
}

function boundedRefreshCause(error: unknown): Record<string, unknown> {
  if (error instanceof KiokukoError) {
    return { code: error.code, message: error.message, details: error.details };
  }
  if (error instanceof SkillSourceError) {
    return {
      code: error.code,
      ...(error.retryAfterSeconds === null ? {} : { retryAfterSeconds: error.retryAfterSeconds }),
    };
  }
  return { type: error instanceof Error ? error.name : 'NonErrorThrow' };
}

function refreshFailureError(progress: RefreshProgress, failures: RefreshFailure[], fatalCause?: { value: unknown }): KiokukoError {
  const sourceFailureCount = progress.failed - (fatalCause === undefined ? 0 : 1);
  const details: Record<string, unknown> = {
    ...progress,
    failures,
    truncated: sourceFailureCount > failures.length,
    ...(fatalCause === undefined ? {} : { cause: boundedRefreshCause(fatalCause.value) }),
  };
  const error = new KiokukoError(
    'PARTIAL_FAILURE',
    progress.failed === 1 ? 'External skill refresh failed' : 'One or more external skill refreshes failed',
    details,
  );
  if (fatalCause !== undefined) {
    withExactCause(error, fatalCause.value);
  }
  return error;
}

function sourceFailureWithBound(failures: RefreshFailure[], failure: RefreshFailure): RefreshFailure[] {
  return failures.length < MAX_REFRESH_FAILURE_DETAILS ? [...failures, failure] : failures;
}

function fatalBatchRefreshError(input: {
  total: number;
  attempted: number;
  completed: number;
  succeeded: number;
  staled: number;
  committed: number;
  failed: number;
  failures: RefreshFailure[];
  cause: unknown;
}): KiokukoError {
  return refreshFailureError({
    attempted: input.attempted,
    completed: input.completed,
    succeeded: input.succeeded,
    staled: input.staled,
    committed: input.committed,
    failed: input.failed + 1,
    remaining: input.total - input.attempted,
  }, input.failures, { value: input.cause });
}

export function registerSkillsCommands(cli: Command, dependencies: SkillsCommandDependencies): void {
  const skills = cli.command('skills').description('Discover and manage external skills as untrusted reference data');
  skills.command('find').argument('<query>').option('--owner <owner>').option('--official-only').option('--json').action(async (query: string, options: { owner?: string; officialOnly?: boolean; json?: boolean }) => {
    let result: Awaited<ReturnType<typeof findSkills>>;
    try {
      result = await findSkills(
        { query, limit: 20, ...(options.owner ? { owner: options.owner } : {}), ...(options.officialOnly ? { officialOnly: true } : {}) },
        dependencies.provider === undefined ? {} : { provider: dependencies.provider },
      );
    } catch (error) {
      if (error instanceof SkillProviderError) throw publicSkillProviderError(error);
      throw error;
    }
    emit(options.json, 'skills.find', result, `${result.candidates.length} skill candidates found`);
  });
  skills.command('import').argument('<skill>').option('--json').action(async (identifier: string, options: { json?: boolean }) => {
    try {
      const candidate = candidateFromIdentifier(identifier);
      const requirement = requirementForOfficialSkill(candidate);
      if (requirement === undefined) throw new KiokukoError('VALIDATION_ERROR', 'Manual Skill import requires an exact reviewed catalog identity');
      const provider = dependencies.provider ?? createSkillRegistryProvider();
      const sourceFetcher = new GitHubSkillSourceFetcher({ token: readSkillDiscoveryConfig().githubToken });
      const result = await dependencies.withDatabase(async (database) => {
        const materializable = await fetchMaterializableSkillSnapshot(database, candidate, { provider, sourceFetcher, sourceRequest: { purpose: 'discovery' } });
        const primary = materializable.snapshot.files.find((file) => file.primary);
        if (!primary) throw new KiokukoError('VALIDATION_ERROR', 'Skill snapshot has no primary document');
        const documents = documentsFromSkillSnapshot(materializable.snapshot);
        return importSkillSnapshot(database, materializable.snapshot, documents, requirement, undefined, materializable.authorization);
      });
      emit(options.json, 'skills.import', result, `Imported ${result.imported} skill documents`);
    } catch (error) {
      if (error instanceof SkillSourceError) throw publicSkillSourceError(error);
      throw error;
    }
  });
  skills.command('list')
    .addOption(new Option('--state <state>', 'Filter by lifecycle state').choices([...EXTERNAL_SKILL_STATES]))
    .option('--json')
    .action(async (options: { state?: string; json?: boolean }) => { const data = await dependencies.withDatabase((database) => listExternalSkills(database, options.state ? { state: options.state } : {})); emit(options.json, 'skills.list', data, `${data.length} external skills`); });
  skills.command('show').argument('<skill>').option('--json').action(async (identifier: string, options: { json?: boolean }) => { const data = await dependencies.withDatabase((database) => { const skill = resolveExternalSkillIdentifier(database, identifier); const detail = readExternalSkill(database, skill.skillId); if (!detail) throw new KiokukoError('INTEGRITY_ERROR', 'External skill row disappeared during read'); return detail; }); emit(options.json, 'skills.show', data, `${data.skill.name} (${data.skill.state})`); });
  for (const action of ['disable', 'enable'] as const) skills.command(action).argument('<skill>').option('--json').action(async (identifier: string, options: { json?: boolean }) => { const state = action === 'disable' ? 'disabled' : 'imported'; const data = await dependencies.withDatabase((database) => { const skill = resolveExternalSkillIdentifier(database, identifier); return setExternalSkillState(database, skill.skillId, state); }); emit(options.json, `skills.${action}`, data, `${data.name} ${action}d`); });
  skills.command('refresh').argument('[skill]').option('--json').action(async (identifier: string | undefined, options: { json?: boolean }) => {
    const selected = await dependencies.withDatabase((database) => identifier === undefined ? listExternalSkills(database) : [resolveExternalSkillIdentifier(database, identifier)]);
    const results: ExternalSkillRefreshResult[] = [];
    let failures: RefreshFailure[] = [];
    let attempted = 0;
    let completed = 0;
    let failed = 0;
    let refreshed = 0;
    let staled = 0;
    let committedMutations = 0;
    const provider = dependencies.provider ?? createSkillRegistryProvider();
    const sourceFetcher = new GitHubSkillSourceFetcher({ token: readSkillDiscoveryConfig().githubToken });
    for (const row of selected) {
      attempted += 1;
      const candidate: SkillCandidate = { id: row.skillId, provider: row.provider, name: row.name, slug: row.slug, source: row.sourceLocator, sourceType: row.sourceType as 'github', installUrl: row.installUrl, installs: row.installs, duplicate: row.duplicate, officialStatus: row.officialStatus as SkillCandidate['officialStatus'], auditStatus: row.auditStatus };
      const expected = { generation: row.generation, sourceCommit: row.sourceCommit, snapshotHash: row.snapshotHash, state: row.state, lastCheckedAt: row.lastCheckedAt };
      try {
        const result = await dependencies.withDatabase(async (database) => {
          const detail = readExternalSkill(database, row.skillId);
          if (detail === undefined) throw new KiokukoError('CONFLICT', 'External skill changed during refresh');
          const materializable = await fetchMaterializableSkillSnapshot(database, candidate, { provider, sourceFetcher, sourceRequest: externalSkillSourceFetchRequest(detail) });
          const primary = materializable.snapshot.files.find((file) => file.primary);
          if (!primary) throw new KiokukoError('VALIDATION_ERROR', 'Skill snapshot has no primary document');
          const documents = documentsFromSkillSnapshot(materializable.snapshot);
          const requirement = externalSkillRequirement(database, row.skillId);
          return refreshExternalSkillSnapshot(database, row.skillId, materializable.snapshot, documents, requirement, expected, undefined, materializable.authorization);
        });
        results.push(result);
        if (result.kind === 'refreshed') refreshed += 1;
        else staled += 1;
        // Even an exact snapshot replay advances the durable candidate generation
        // and last-seen metadata before the import path returns updated=false.
        committedMutations += 1;
        completed += 1;
      } catch (error) {
        if (!(error instanceof SkillSourceError)) {
          if (identifier === undefined && committedMutations > 0) {
            throw fatalBatchRefreshError({
              total: selected.length,
              attempted,
              completed,
              succeeded: refreshed,
              staled,
              committed: committedMutations,
              failed,
              failures,
              cause: error,
            });
          }
          throw error;
        }
        const failureCode = declaredSkillSourceFailureCode(error);
        if (failureCode === undefined) {
          if (identifier === undefined && committedMutations > 0) {
            throw fatalBatchRefreshError({
              total: selected.length,
              attempted,
              completed,
              succeeded: refreshed,
              staled,
              committed: committedMutations,
              failed,
              failures,
              cause: error,
            });
          }
          throw error;
        }
        const currentFailure = { skillId: row.skillId, code: failureCode } satisfies RefreshFailure;
        const failedState = refreshFailureState(failureCode);
        if (failedState !== null) {
          try {
            await dependencies.withDatabase((database) => markExternalSkillRefreshFailure(database, row.skillId, failedState, expected));
            committedMutations += 1;
            if (failedState === 'stale') staled += 1;
          } catch (transitionError) {
            if (identifier === undefined && committedMutations > 0) {
              throw fatalBatchRefreshError({
                total: selected.length,
                attempted,
                completed,
                succeeded: refreshed,
                staled,
                committed: committedMutations,
                failed,
                failures,
                cause: transitionError,
              });
            }
            throw transitionError;
          }
        }
        if (identifier !== undefined) throw publicSkillSourceError(error);
        failed += 1;
        failures = sourceFailureWithBound(failures, currentFailure);
        completed += 1;
        if (failureCode === 'source_rate_limited') {
          throw refreshFailureError({
            attempted,
            completed,
            succeeded: refreshed,
            staled,
            committed: committedMutations,
            failed,
            remaining: selected.length - attempted,
          }, failures);
        }
      }
    }
    if (failed > 0) {
      throw refreshFailureError({
        attempted,
        completed,
        succeeded: refreshed,
        staled,
        committed: committedMutations,
        failed,
        remaining: selected.length - attempted,
      }, failures);
    }
    emit(options.json, 'skills.refresh', { results, failures, refreshed, staled, committed: committedMutations }, `Refreshed ${refreshed} external skills; marked ${staled} stale`);
  });
  skills.command('prune-cache').option('--json').action(async (options: { json?: boolean }) => {
    const result = await dependencies.withDatabase((database) => pruneExternalSkillCaches(database));
    emit(options.json, 'skills.prune-cache', result, `Removed ${result.total} expired cache entries`);
  });
}
