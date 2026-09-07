import { lstat } from 'node:fs/promises';
import path from 'node:path';
import { readRegularFile } from '../agent-file/atomic-write.js';
import { readManagedBlockTemplateVersion } from '../agent-file/managed-block.js';
import { AGENT_TEMPLATE_VERSION } from '../agent-file/render.js';
import { parseProjectConfigText } from '../config/project-config.js';
import { KiokukoError } from '../errors.js';
import type { RegisteredProjectLocation } from './project-agent-refresh.js';

export type ProjectAgentIssue =
  | 'missing_root' | 'unsafe_root' | 'inaccessible_root'
  | 'binding_missing' | 'binding_invalid' | 'binding_unreadable' | 'binding_mismatch'
  | 'agent_file_missing' | 'agent_file_unreadable'
  | 'managed_block_missing' | 'managed_block_invalid' | 'outdated_template' | 'newer_template';

export interface ProjectAgentFinding {
  repositoryRoot: string;
  agentFile: string | null;
  reason: ProjectAgentIssue;
  repair: 'setup' | 'manual' | 'remove_missing_location';
}

export type ProjectAgentHealth = { ok: true; agentFile: string } | { ok: false; finding: ProjectAgentFinding };

function expectedReadError(error: unknown): boolean {
  return error instanceof KiokukoError || (error instanceof Error && 'code' in error
    && ['ENOENT', 'ENOTDIR', 'EACCES', 'EPERM', 'ELOOP', 'EISDIR'].includes(String(error.code)));
}

/** Inspect the same binding and marker boundaries that `use` accepts, without writes. */
export async function inspectProjectAgentFile(location: RegisteredProjectLocation): Promise<ProjectAgentHealth> {
  const finding = (reason: ProjectAgentIssue, repair: ProjectAgentFinding['repair'], agentFile: string | null = null): ProjectAgentHealth =>
    ({ ok: false, finding: { repositoryRoot: location.repositoryRoot, agentFile, reason, repair } });
  try {
    const root = await lstat(location.repositoryRoot);
    if (root.isSymbolicLink() || !root.isDirectory()) return finding('unsafe_root', 'manual');
  } catch (error) {
    if (!expectedReadError(error)) throw error;
    if (error instanceof Error && 'code' in error && ['ENOENT', 'ENOTDIR'].includes(String(error.code))) {
      return finding('missing_root', 'remove_missing_location');
    }
    return finding('inaccessible_root', 'manual');
  }
  let binding;
  try {
    const snapshot = await readRegularFile(path.join(location.repositoryRoot, '.kiokuko.json'), { containmentRoot: location.repositoryRoot });
    if (snapshot === undefined) return finding('binding_missing', 'setup');
    try { binding = parseProjectConfigText(snapshot.content); }
    catch (error) { if (!(error instanceof KiokukoError)) throw error; return finding('binding_invalid', 'manual'); }
  } catch (error) {
    if (!expectedReadError(error)) throw error;
    return finding('binding_unreadable', 'manual');
  }
  const agentFile = path.join(location.repositoryRoot, binding.agentFile);
  if (binding.repositoryId !== location.repositoryId || binding.workspace !== location.workspace) return finding('binding_mismatch', 'manual', agentFile);
  if (binding.templateVersion > AGENT_TEMPLATE_VERSION) return finding('newer_template', 'manual', agentFile);
  let agent;
  try {
    agent = await readRegularFile(agentFile, { containmentRoot: location.repositoryRoot });
    if (agent === undefined) return finding('agent_file_missing', 'setup', agentFile);
  } catch (error) {
    if (!expectedReadError(error)) throw error;
    return finding('agent_file_unreadable', 'manual', agentFile);
  }
  let version;
  try { version = readManagedBlockTemplateVersion(agent.content); }
  catch (error) { if (!(error instanceof KiokukoError)) throw error; return finding('managed_block_invalid', 'manual', agentFile); }
  if (version === undefined) return finding('managed_block_missing', 'setup', agentFile);
  if (version > AGENT_TEMPLATE_VERSION) return finding('newer_template', 'manual', agentFile);
  if (version < AGENT_TEMPLATE_VERSION || binding.templateVersion < AGENT_TEMPLATE_VERSION) return finding('outdated_template', 'setup', agentFile);
  return { ok: true, agentFile };
}

const DESCRIPTIONS: Record<ProjectAgentIssue, string> = {
  missing_root: 'Registered directory is missing; review its registration with kiokuko-ai doctor.',
  unsafe_root: 'Registered path is a link or not a directory; inspect the path manually.',
  inaccessible_root: 'Registered directory cannot be read; check its permissions.',
  binding_missing: 'Project binding is missing; kiokuko-ai setup can restore it from the registration.',
  binding_invalid: 'Project binding is malformed; inspect .kiokuko.json before retrying setup.',
  binding_unreadable: 'Project binding cannot be read safely; check .kiokuko.json and its permissions.',
  binding_mismatch: 'Project binding differs from the registered identity; reconcile it before retrying setup.',
  agent_file_missing: 'Agent file is missing; kiokuko-ai setup can recreate it.',
  agent_file_unreadable: 'Agent file cannot be read safely; check its path and permissions.',
  managed_block_missing: 'Kiokuko managed block is missing; kiokuko-ai setup can append it while preserving human text.',
  managed_block_invalid: 'Kiokuko markers or template declaration are malformed; repair their boundaries manually before setup.',
  outdated_template: 'Project instructions are outdated; kiokuko-ai setup can refresh them.',
  newer_template: 'Project instructions require a newer Kiokuko version; update the package before setup.',
};

export function describeProjectAgentFinding(finding: ProjectAgentFinding): string {
  return `${JSON.stringify(finding.repositoryRoot)}: ${finding.reason}. ${DESCRIPTIONS[finding.reason]}`;
}
