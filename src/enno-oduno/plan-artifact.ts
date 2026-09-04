import { createHash } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import type { SqliteDatabase, SqliteRow } from '../db/adapter.js';
import { getPlatformDataDirectory } from '../config/paths.js';
import { KiokukoError } from '../errors.js';
import { canonicalContentHash, canonicalJson } from '../serialization/validate.js';
import {
  assertAtomicCleanupComplete,
  atomicWriteTextIfUnchanged,
  readDirectoryIdentity,
  readRegularFile,
} from '../agent-file/atomic-write.js';
import type { EnnoOdunoContract, PlanArtifact } from './types.js';

interface PlanArtifactRow extends SqliteRow {
  plan_digest: unknown;
  relative_path: unknown;
  state: unknown;
}

function workspaceHash(workspace: string, repositoryRoot: string): string {
  return canonicalContentHash({ workspace, repositoryRoot }).slice(0, 32);
}

function relativePlanPath(input: {
  workspace: string;
  repositoryRoot: string;
  runId: string;
  contractRevision: number;
}): string {
  return path.join(
    'orchestrations',
    workspaceHash(input.workspace, input.repositoryRoot),
    input.runId,
    String(input.contractRevision),
    'PLAN.md',
  );
}

export function renderPlanArtifact(contract: EnnoOdunoContract): string {
  const units = contract.workPlan.units.map((unit, index) => {
    const resources = unit.resourceClaims ?? [];
    return [
      `## ${index + 1}. ${unit.id}`,
      '',
      unit.objective,
      '',
      `- Scope: ${unit.scope.join(', ')}`,
      `- Dependencies: ${unit.dependencies.join(', ') || 'none'}`,
      `- Isolation: ${unit.isolationPreference ?? 'shared_serial'}`,
      `- Resources: ${resources.map((claim) => `${claim.access}:${claim.key}`).join(', ') || 'none'}`,
      `- Skills: ${unit.skillNames.join(', ') || 'none'}`,
      `- Input manifest: ${unit.inputManifestDigest ?? 'unavailable'}`,
      `- Output contract: ${unit.outputContract ?? 'Return one bounded WorkUnit report.'}`,
      '',
      'Acceptance criteria:',
      ...unit.acceptanceCriteria.map((criterion) => `- ${criterion}`),
      '',
      'Focused verifiers:',
      ...(unit.focusedVerifiers.length === 0
        ? ['- none']
        : unit.focusedVerifiers.map((verifier) => `- ${verifier.executable} ${verifier.args.join(' ')}`.trim())),
    ].join('\n');
  });
  return [
    '# Kiokuko WorkPlan',
    '',
    `Contract revision: ${contract.revision}`,
    '',
    contract.workPlan.objective,
    '',
    ...units,
    '',
  ].join('\n');
}

function planContentDigest(markdown: string): string {
  return createHash('sha256').update(markdown, 'utf8').digest('hex');
}

export function stagePlanArtifactInTransaction(database: SqliteDatabase, input: {
  workspace: string;
  repositoryRoot: string;
  runId: string;
  contract: EnnoOdunoContract;
}): PlanArtifact {
  const markdown = renderPlanArtifact(input.contract);
  const digest = planContentDigest(markdown);
  const relativePath = relativePlanPath({
    workspace: input.workspace,
    repositoryRoot: input.repositoryRoot,
    runId: input.runId,
    contractRevision: input.contract.revision,
  });
  const now = new Date().toISOString();
  database.prepare(`
    INSERT INTO enno_plan_artifacts (
      run_id, contract_revision, plan_digest, relative_path, content_json,
      state, error_code, created_at, published_at
    ) VALUES (?, ?, ?, ?, ?, 'pending', NULL, ?, NULL)
    ON CONFLICT(run_id, contract_revision) DO NOTHING
  `).run(
    input.runId,
    input.contract.revision,
    digest,
    relativePath,
    canonicalJson({ markdown }),
    now,
  );
  const artifact = readPlanArtifact(database, input.runId, input.contract.revision);
  if (artifact === null || artifact.digest !== digest || artifact.path !== relativePath) {
    throw new KiokukoError('CONFLICT', 'Plan artifact revision already has different content');
  }
  return artifact;
}

export function readPlanArtifact(
  database: SqliteDatabase,
  runId: string,
  contractRevision: number,
): PlanArtifact | null {
  const row = database.prepare(`
    SELECT plan_digest, relative_path, state
    FROM enno_plan_artifacts
    WHERE run_id = ? AND contract_revision = ?
  `).get<PlanArtifactRow>(runId, contractRevision);
  if (row === undefined) return null;
  if (typeof row.plan_digest !== 'string'
    || typeof row.relative_path !== 'string'
    || (row.state !== 'pending' && row.state !== 'published' && row.state !== 'failed')) {
    throw new KiokukoError('INTEGRITY_ERROR', 'Stored plan artifact is invalid');
  }
  return { path: row.relative_path, digest: row.plan_digest, state: row.state };
}

export async function publishPlanArtifact(database: SqliteDatabase, input: {
  runId: string;
  contractRevision: number;
  dataDirectory?: string;
}): Promise<PlanArtifact> {
  const row = database.prepare(`
    SELECT plan_digest, relative_path, content_json, state
    FROM enno_plan_artifacts
    WHERE run_id = ? AND contract_revision = ?
  `).get<PlanArtifactRow & { content_json: unknown }>(input.runId, input.contractRevision);
  if (row === undefined || typeof row.plan_digest !== 'string' || typeof row.relative_path !== 'string'
    || typeof row.content_json !== 'string') {
    throw new KiokukoError('NOT_FOUND', 'Plan artifact was not staged');
  }
  let content: unknown;
  try {
    content = JSON.parse(row.content_json);
  } catch {
    throw new KiokukoError('INTEGRITY_ERROR', 'Stored plan artifact content is invalid');
  }
  const markdown = typeof content === 'object' && content !== null && !Array.isArray(content)
    ? (content as { markdown?: unknown }).markdown
    : undefined;
  if (typeof markdown !== 'string' || planContentDigest(markdown) !== row.plan_digest) {
    throw new KiokukoError('INTEGRITY_ERROR', 'Stored plan artifact digest is invalid');
  }
  const root = path.resolve(input.dataDirectory ?? getPlatformDataDirectory());
  const target = path.resolve(root, row.relative_path);
  if (!target.startsWith(`${root}${path.sep}`)) {
    throw new KiokukoError('SECURITY_REJECTION', 'Plan artifact path escapes the Kiokuko data directory');
  }
  try {
    await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
    const current = await readRegularFile(target, { containmentRoot: root });
    if (current === undefined) {
      const parentIdentity = await readDirectoryIdentity(path.dirname(target));
      if (parentIdentity === undefined) throw new KiokukoError('CONFLICT', 'Plan artifact directory changed');
      const outcome = await atomicWriteTextIfUnchanged(target, markdown, {
        expected: undefined,
        containmentRoot: root,
        expectedParentDirectory: parentIdentity,
      }, 0o600);
      assertAtomicCleanupComplete(outcome);
    } else if (planContentDigest(current.content) !== row.plan_digest) {
      throw new KiokukoError('CONFLICT', 'Refusing to overwrite a different plan artifact');
    }
    const readBack = await readRegularFile(target, { containmentRoot: root });
    if (readBack === undefined || planContentDigest(readBack.content) !== row.plan_digest) {
      throw new KiokukoError('INTEGRITY_ERROR', 'Plan artifact read-back digest mismatch');
    }
    const now = new Date().toISOString();
    database.prepare(`
      UPDATE enno_plan_artifacts
      SET state = 'published', error_code = NULL, published_at = ?
      WHERE run_id = ? AND contract_revision = ? AND plan_digest = ?
    `).run(now, input.runId, input.contractRevision, row.plan_digest);
  } catch (error) {
    database.prepare(`
      UPDATE enno_plan_artifacts
      SET state = 'failed', error_code = ?
      WHERE run_id = ? AND contract_revision = ? AND plan_digest = ?
    `).run(
      error instanceof KiokukoError ? error.code : 'PLAN_PUBLISH_FAILED',
      input.runId,
      input.contractRevision,
      row.plan_digest,
    );
    throw error;
  }
  return {
    path: row.relative_path,
    digest: row.plan_digest,
    state: 'published',
  };
}
