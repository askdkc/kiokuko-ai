import type { GatewayIntakeResponse } from '../../gateway/agent-service.js';
import type { ContextBrokerContextItem, ContextBrokerResult } from '../../context/broker.js';
import { contextFeedbackSignals } from '../../context/feedback.js';
import { entryOriginMatchesWorkspace } from '../../context/origin.js';
import { KiokukoError } from '../../errors.js';
import { LedgerStore } from '../../ledger/store.js';
import { readEntry } from '../../memory/entries.js';
import { isRetrievableEntry, retrievableWorkspaceEntryCount } from '../../memory/hybrid-retrieval.js';
import { effectiveRetrievalScope, hasExplicitApplicability } from '../../memory/structured-memory.js';
import { isExternalSkillReference } from '../../skills/store.js';
import { isCuratorManagedGlobalMemory } from '../../memory/curator-trust.js';
import type { TaskProfile } from '../../akinator/types.js';
import {
  deriveMemoryUseSignal,
  deriveMemoryPolicy,
  hasBlockingRequiredCapability,
  resolveCapabilities,
  shouldWithholdMemoryContext,
  type CapabilityResolution,
  type CapabilityWarning,
  type MemoryPolicy,
} from '../../akinator/capabilities.js';
import type { AgentRouteContext } from './agent-runs.js';
import { brokerPersistence } from './task5-support.js';

export type AgentCapabilityNextAction =
  | 'proceed'
  | 'answer_from_evidence_or_ask_user'
  | 'required_capability_unavailable';

export type CapabilityGatedIntakeResponse = Omit<GatewayIntakeResponse, 'context'> & {
  context: ContextBrokerResult['context'];
  recommendations: ContextBrokerResult['recommendations'];
  capabilities: CapabilityResolution;
  memoryPolicy: MemoryPolicy;
  warnings: CapabilityWarning[];
  nextAction: AgentCapabilityNextAction;
};

export interface AgentCapabilityGateInput {
  task: string;
  intakeStatus: 'needs_answer' | 'ready' | 'exhausted';
  taskProfile: TaskProfile;
  recommendedTags: string[];
  catalog: unknown;
  broker: Pick<ContextBrokerResult, 'context' | 'recommendations'>;
  memoryUseOverride?: 'none' | 'actionable';
  storedEntryCount?: number;
}

export interface AgentCapabilityGateResult {
  context: ContextBrokerResult['context'];
  recommendations: ContextBrokerResult['recommendations'];
  capabilities: CapabilityResolution;
  memoryPolicy: MemoryPolicy;
  warnings: CapabilityWarning[];
  nextAction: AgentCapabilityNextAction;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasHelpfulFeedbackEvidence(
  context: Pick<AgentRouteContext, 'database'>,
  items: ReadonlyArray<{ entryId: string }>,
): boolean {
  return items.some((item) => contextFeedbackSignals(context.database, item.entryId)
    .some((signal) => signal.verdict === 'helpful'));
}

function capabilityGatedBrokerItems(
  context: Pick<AgentRouteContext, 'database'>,
  broker: Pick<ContextBrokerResult, 'context'>,
): ContextBrokerContextItem[] {
  const delivered = broker.context;
  if (delivered === null) return [];
  if (delivered.runId === null) {
    if (delivered.items.length === 0) return [];
    throw new KiokukoError('INTEGRITY_ERROR', 'Model-facing context is not bound to a run');
  }
  const run = new LedgerStore(context.database).readRun(delivered.runId);
  if (run === undefined) throw new KiokukoError('INTEGRITY_ERROR', 'Model-facing context run is missing');
  return delivered.items.filter((item) => {
    const row = context.database.prepare('SELECT workspace FROM entries WHERE id = ?')
      .get<{ workspace: unknown }>(item.entryId);
    if (row === undefined || typeof row.workspace !== 'string' || row.workspace.length === 0) {
      throw new KiokukoError('INTEGRITY_ERROR', 'Model-facing context entry is missing or invalid');
    }
    const origin = item.origin ?? 'project';
    const entry = readEntry(
      context.database,
      { workspace: row.workspace, entryId: item.entryId },
      { requireStructuredScope: origin !== 'project' },
    );
    if (entry.revision !== item.entryRevision) {
      throw new KiokukoError('CONFLICT', 'Model-facing context entry changed after ranking');
    }
    if (!entryOriginMatchesWorkspace({ origin, runWorkspace: run.workspace, entryWorkspace: entry.workspace })) {
      throw new KiokukoError('INTEGRITY_ERROR', 'Model-facing context entry origin is invalid');
    }
    if (origin === 'global'
      && (entry.scope.visibility !== 'global' || effectiveRetrievalScope(entry.scope) !== 'global')) {
      throw new KiokukoError('INTEGRITY_ERROR', 'Model-facing global context entry scope is invalid');
    }
    if (origin === 'ecosystem'
      && (!Object.hasOwn(entry.scope, 'retrievalScope')
        || effectiveRetrievalScope(entry.scope) !== 'ecosystem'
        || !hasExplicitApplicability(entry.scope))) {
      throw new KiokukoError('INTEGRITY_ERROR', 'Model-facing ecosystem context entry scope is invalid');
    }
    if (!isRetrievableEntry(context.database, entry)) {
      throw new KiokukoError('CONFLICT', 'Model-facing context entry is no longer retrievable');
    }
    if (entry.status === 'superseded') {
      throw new KiokukoError('CONFLICT', 'Model-facing context entry is no longer retrievable');
    }
    return !isExternalSkillReference(entry) && !isCuratorManagedGlobalMemory(entry);
  });
}

export function deriveBrokerMemoryUseSignal(
  context: Pick<AgentRouteContext, 'database'>,
  broker: Pick<ContextBrokerResult, 'context'>,
): 'none' | 'actionable' {
  if (broker.context === null) return 'none';
  const items = capabilityGatedBrokerItems(context, broker);
  const derived = deriveMemoryUseSignal({ ...broker.context, items });
  if (derived === 'actionable') return derived;
  return items.length > 0 && hasHelpfulFeedbackEvidence(context, items)
    ? 'actionable'
    : 'none';
}

export function brokerIntakeStatus(
  status: ContextBrokerResult['status'],
): AgentCapabilityGateInput['intakeStatus'] {
  if (status === 'needs_answer' || status === 'ready' || status === 'exhausted') return status;
  throw new KiokukoError('INTEGRITY_ERROR', 'Model-facing context is not bound to an intake');
}

export function assertBrokerContextRun(candidate: Pick<ContextBrokerResult, 'context'>, runId: string): void {
  if (candidate.context !== null && candidate.context.runId !== runId) {
    throw new KiokukoError('INTEGRITY_ERROR', 'Model-facing context is bound to the wrong run');
  }
}

function assertNonTerminalRun(run: { status: string }): asserts run is { status: 'intake' | 'active' } {
  if (run.status !== 'intake' && run.status !== 'active') {
    throw new KiokukoError('CONFLICT', 'Agent run is terminal');
  }
}

export function requestCapabilityCatalog(value: unknown): unknown {
  return isPlainRecord(value) ? value.capabilities : undefined;
}

function nextAction(
  intakeStatus: AgentCapabilityGateInput['intakeStatus'],
  capabilities: CapabilityResolution,
): AgentCapabilityNextAction {
  if (intakeStatus === 'needs_answer') return 'answer_from_evidence_or_ask_user';
  return hasBlockingRequiredCapability(capabilities)
    ? 'required_capability_unavailable'
    : 'proceed';
}

function resolution(
  input: Pick<AgentCapabilityGateInput, 'task' | 'taskProfile' | 'recommendedTags' | 'catalog'>,
  memoryUse: 'none' | 'actionable',
): CapabilityResolution {
  return resolveCapabilities({
    task: input.task,
    profile: input.taskProfile,
    recommendedTags: input.recommendedTags,
    ...(input.catalog === undefined ? {} : { capabilities: input.catalog }),
    memoryUse,
  });
}

export function applyAgentCapabilityGate(input: AgentCapabilityGateInput): AgentCapabilityGateResult {
  const memoryUse = input.intakeStatus === 'ready'
    ? input.memoryUseOverride ?? deriveMemoryUseSignal(input.broker.context)
    : 'none';
  const capabilities = resolution(input, memoryUse);
  const action = nextAction(input.intakeStatus, capabilities);
  const withholdMemory = input.intakeStatus === 'ready' && shouldWithholdMemoryContext(capabilities);
  const deliveredContext = action === 'required_capability_unavailable' || withholdMemory ? null : input.broker.context;
  return {
    context: deliveredContext,
    recommendations: action === 'required_capability_unavailable' || withholdMemory ? [] : input.broker.recommendations,
    capabilities,
    memoryPolicy: deriveMemoryPolicy(
      input.taskProfile,
      memoryUse,
      input.catalog,
      input.intakeStatus !== 'ready' || input.storedEntryCount === undefined
        ? undefined
        : {
          contextItemCount: deliveredContext?.items.length ?? null,
          storedEntryCount: input.storedEntryCount,
        },
    ),
    warnings: capabilities.warnings,
    nextAction: action,
  };
}

/** Count stored entries only when the final model-facing context is empty. */
export function applyAgentCapabilityGateWithDeliveryObservation(
  input: Omit<AgentCapabilityGateInput, 'storedEntryCount'>,
  countStoredEntries: () => number,
): AgentCapabilityGateResult {
  const initial = applyAgentCapabilityGate(input);
  if (input.intakeStatus !== 'ready'
    || (initial.context !== null && initial.context.items.length > 0)) {
    return initial;
  }
  return applyAgentCapabilityGate({
    ...input,
    storedEntryCount: countStoredEntries(),
  });
}

/** Rank once, decide against that immutable snapshot, and persist only the
 * exact approved delivery. A rejected or throwing gate never writes context. */
export async function attachCapabilityGatedContext(
  context: AgentRouteContext,
  value: GatewayIntakeResponse,
  catalog: unknown,
): Promise<CapabilityGatedIntakeResponse> {
  const run = context.service.readRun({ runId: value.runId });
  assertNonTerminalRun(run);
  const task = run.title ?? '';
  const gated = await context.broker.queryGated({ workspace: 'run-bound', runId: value.runId }, (candidate) => {
    assertBrokerContextRun(candidate, value.runId);
    const memoryUse = deriveBrokerMemoryUseSignal(context, candidate);
    const result = applyAgentCapabilityGateWithDeliveryObservation({
      task,
      intakeStatus: brokerIntakeStatus(candidate.status),
      taskProfile: candidate.taskProfile,
      recommendedTags: candidate.recommendedTags,
      catalog,
      broker: candidate,
      memoryUseOverride: memoryUse,
    }, () => retrievableWorkspaceEntryCount(context.database, run.workspace));
    return {
      persist: result.context !== null || candidate.context === null,
      value: result,
      assertBeforePersist: () => {
        if (deriveBrokerMemoryUseSignal(context, candidate) !== memoryUse) {
          throw new KiokukoError('CONFLICT', 'Memory capability decision changed before context persistence');
        }
      },
    };
  }, brokerPersistence(context));
  const current = context.service.readIntake({ runId: value.runId });
  const finalRun = context.service.readRun({ runId: value.runId });
  assertNonTerminalRun(finalRun);
  if (finalRun.lastSequence !== gated.broker.acceptedThrough) {
    throw new KiokukoError('CONFLICT', 'Agent run changed while context was being prepared');
  }
  const intakeStatus = brokerIntakeStatus(gated.broker.status);
  if (current.intakeStatus !== intakeStatus || current.intakeSessionId !== gated.broker.intakeSessionId) {
    throw new KiokukoError('INTEGRITY_ERROR', 'Agent intake and context broker state disagree');
  }
  const expectedRunStatus = intakeStatus === 'needs_answer' ? 'intake' : 'active';
  if (finalRun.status !== expectedRunStatus) {
    throw new KiokukoError('INTEGRITY_ERROR', 'Agent run status and context broker state disagree');
  }
  return {
    ...current,
    runStatus: finalRun.status,
    intakeStatus,
    intake: { ...current.intake, status: intakeStatus },
    taskProfile: { ...gated.broker.taskProfile },
    // A partial intake profile is mutable and has no finalized identity. Once
    // active, the broker projection is authoritative and may be newer than the
    // intake link after a checkpoint profile revision.
    profileHash: intakeStatus === 'needs_answer' ? null : gated.broker.profileHash,
    recommendedTags: [...gated.broker.recommendedTags],
    ...gated.value,
  };
}
