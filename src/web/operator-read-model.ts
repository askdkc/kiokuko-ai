import type { SqliteDatabase } from '../db/adapter.js';
import { resolveHarnessProfile, decideContinuationPolicy } from '../enno-oduno/harness.js';
import type { HarnessProfile } from '../enno-oduno/types.js';
import { listExternalSkills, type ExternalSkillRecord } from '../skills/store.js';
import { requireWorkspace } from '../serialization/validate.js';

const MAX_OPERATOR_SKILLS = 1_000;

export interface OperatorRunSummary {
  readonly runId: string;
  readonly status: string;
  readonly title: string | null;
  readonly updatedAt: string;
  readonly currentRole: 'enno-oduno' | 'zenki' | 'goki' | null;
  readonly nextAction: string | null;
  readonly blocker: string | null;
  readonly revision: number | null;
}

export interface OperatorOverview {
  readonly workspace: string;
  readonly activeRun: OperatorRunSummary | null;
  readonly activeRuns: readonly OperatorRunSummary[];
  readonly counts: Readonly<Record<string, number>>;
  readonly generatedAt: string;
}

export interface OperatorHarnessSummary {
  readonly profile: HarnessProfile;
  readonly policy: ReturnType<typeof decideContinuationPolicy>;
  readonly evidence: readonly [{ field: 'adapter'; value: string; source: 'stored_client_binding'; verified: false }];
  readonly unsupported: readonly string[];
  readonly observedVersions: readonly string[];
}

export interface OperatorSkillSummary {
  readonly skillId: string;
  readonly name: string;
  readonly provider: string;
  readonly source: string;
  readonly sourceCommit: string | null;
  readonly snapshotHash: string | null;
  readonly state: string;
  readonly auditStatus: string;
  readonly trustState: 'reference_only' | 'materialized_untrusted';
  readonly generation: number;
  readonly documents: number;
  readonly technology: string | null;
  readonly firstSeenAt: string;
  readonly lastCheckedAt: string;
}

export interface OperatorSkillSnapshot {
  readonly workspace: string;
  readonly skills: readonly OperatorSkillSummary[];
  readonly count: number;
  readonly untrusted: true;
}

function roleForStatus(status: string): OperatorRunSummary['currentRole'] {
  if (status === 'zenki_planning' || status === 'needs_confirmation') return 'zenki';
  if (status === 'goki_executing') return 'goki';
  if (status === 'intake' || status === 'enno_verifying' || status === 'completed' || status === 'blocked' || status === 'cancelled') return 'enno-oduno';
  return null;
}

function nextActionForStatus(status: string): string | null {
  const actions: Record<string, string> = {
    intake: 'answer_intake',
    zenki_planning: 'submit_plan',
    needs_confirmation: 'ask_user_confirmation',
    goki_executing: 'execute_work_unit',
    enno_verifying: 'run_final_verification',
    completed: 'complete',
    blocked: 'report_blocker',
    cancelled: 'complete',
  };
  return actions[status] ?? null;
}

function contractSummary(database: SqliteDatabase, runId: string): Pick<OperatorRunSummary, 'blocker' | 'revision'> {
  const row = database.prepare('SELECT blocker, revision FROM enno_contracts WHERE run_id = ?').get<{ blocker: string | null; revision: number }>(runId);
  return row === undefined ? { blocker: null, revision: null } : { blocker: row.blocker, revision: row.revision };
}

function runSummary(database: SqliteDatabase, row: { runId: string; status: string; title: string | null; updatedAt: string }): OperatorRunSummary {
  const contract = contractSummary(database, row.runId);
  return Object.freeze({
    runId: row.runId,
    status: row.status,
    title: row.title,
    updatedAt: row.updatedAt,
    currentRole: roleForStatus(row.status),
    nextAction: nextActionForStatus(row.status),
    blocker: contract.blocker,
    revision: contract.revision,
  });
}

export function readOperatorOverview(database: SqliteDatabase, workspaceInput: string): OperatorOverview {
  const workspace = requireWorkspace(workspaceInput);
  const rows = database.prepare(`
    SELECT run_id AS runId, status, title, updated_at AS updatedAt
      FROM ledger_runs
     WHERE workspace = ?
     ORDER BY updated_at DESC, run_id ASC
     LIMIT 100
  `).all<{ runId: string; status: string; title: string | null; updatedAt: string }>(workspace);
  const runs = rows.map((row) => runSummary(database, row));
  const counts: Record<string, number> = {};
  for (const run of runs) counts[run.status] = (counts[run.status] ?? 0) + 1;
  const activeRuns = runs.filter((run) => run.status === 'active' || run.status === 'intake');
  return Object.freeze({
    workspace,
    activeRun: activeRuns.length === 1 ? activeRuns[0]! : null,
    activeRuns: Object.freeze(activeRuns),
    counts: Object.freeze(counts),
    generatedAt: new Date().toISOString(),
  });
}

function unsupportedProfileFields(profile: HarnessProfile): string[] {
  const unsupported: string[] = [];
  if (profile.continuation === 'manual') unsupported.push('continuation');
  if (profile.executionLifetime === 'unknown') unsupported.push('executionLifetime');
  if (profile.workspaceIsolation === 'unknown') unsupported.push('workspaceIsolation');
  if (profile.advisors === 'unknown' || profile.advisors === 'unavailable') unsupported.push('advisors');
  if (profile.approvals === 'unavailable') unsupported.push('approvals');
  if (profile.toolInventory === 'unknown') unsupported.push('toolInventory');
  if (profile.filesystem === 'unknown') unsupported.push('filesystem');
  if (profile.network === 'unknown') unsupported.push('network');
  return unsupported;
}

export function readOperatorHarnesses(database: SqliteDatabase): { readonly harnesses: readonly OperatorHarnessSummary[] } {
  const rows = database.prepare(`
    SELECT client_kind AS clientKind, client_version AS clientVersion
      FROM ledger_runs
     GROUP BY client_kind, client_version
     ORDER BY client_kind, client_version
  `).all<{ clientKind: string; clientVersion: string | null }>();
  const grouped = new Map<string, { clientKind: string; versions: Set<string> }>();
  for (const row of rows) {
    const key = row.clientKind;
    const current = grouped.get(key) ?? { clientKind: row.clientKind, versions: new Set<string>() };
    if (row.clientVersion !== null) current.versions.add(row.clientVersion);
    grouped.set(key, current);
  }
  const harnesses = [...grouped.values()].map((item) => {
    const profile = resolveHarnessProfile({ adapter: item.clientKind });
    const policy = decideContinuationPolicy(profile);
    return Object.freeze({
      profile,
      policy,
      evidence: Object.freeze([{ field: 'adapter' as const, value: item.clientKind, source: 'stored_client_binding' as const, verified: false as const }]) as OperatorHarnessSummary['evidence'],
      unsupported: Object.freeze(unsupportedProfileFields(profile)),
      observedVersions: Object.freeze([...item.versions].sort()),
    });
  });
  return Object.freeze({ harnesses: Object.freeze(harnesses) });
}

function skillSummary(record: ExternalSkillRecord): OperatorSkillSummary {
  const metadata = record.metadata as Record<string, unknown>;
  const documents = typeof metadata.documents === 'number' && Number.isSafeInteger(metadata.documents) ? metadata.documents : 0;
  const technology = typeof metadata.technology === 'string' ? metadata.technology : null;
  return Object.freeze({
    skillId: record.skillId,
    name: record.name,
    provider: record.provider,
    source: record.sourceLocator,
    sourceCommit: record.sourceCommit,
    snapshotHash: record.snapshotHash,
    state: record.state,
    auditStatus: record.auditStatus,
    trustState: record.sourceCommit === null ? 'reference_only' : 'materialized_untrusted',
    generation: record.generation,
    documents,
    technology,
    firstSeenAt: record.firstSeenAt,
    lastCheckedAt: record.lastCheckedAt,
  });
}

export function readOperatorSkills(database: SqliteDatabase, workspaceInput: string): OperatorSkillSnapshot {
  const workspace = requireWorkspace(workspaceInput);
  const skills = listExternalSkills(database, { limit: MAX_OPERATOR_SKILLS })
    .filter((skill) => skill.sourceWorkspace === workspace)
    .map(skillSummary);
  return Object.freeze({ workspace, skills: Object.freeze(skills), count: skills.length, untrusted: true });
}
