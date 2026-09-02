import { KiokukoError } from '../errors.js';
import { checkpointEligibility } from '../ledger/checkpoint-eligibility.js';
import type { RunStatus } from '../ledger/types.js';
import type { AgentGatewayService } from '../gateway/agent-service.js';
import type { CheckpointMutationPort, CheckpointMutationResult } from '../gateway/checkpoint-mutation-service.js';
import type { NudgeDeliveryPort } from '../gateway/nudge-delivery-service.js';
import type { ContextBroker, ContextBrokerResult } from '../context/broker.js';
import type { DeliveredNudge } from '../context/nudges.js';
import type { Recommendation } from '../context/recommendations.js';
import { buildRecommendations } from '../context/recommendations.js';
import { canonicalJson } from '../serialization/validate.js';
import { successEnvelope } from '../serialization/envelope.js';
import { assertCapabilityCatalogBinding } from '../akinator/capability-binding.js';
import { retrievableWorkspaceEntryCount } from '../memory/hybrid-retrieval.js';
import type { CapabilityGatedIntakeResponse } from './routes/agent-capability-gate.js';
import {
  applyAgentCapabilityGateWithDeliveryObservation,
  assertBrokerContextRun,
  brokerIntakeStatus,
  deriveBrokerMemoryUseSignal,
  requestCapabilityCatalog,
} from './routes/agent-capability-gate.js';

export interface AgentCheckpointUseCaseDependencies {
  readonly database: import('../db/adapter.js').SqliteDatabase;
  readonly service: AgentGatewayService;
  readonly checkpointMutation: CheckpointMutationPort;
  readonly validateMutationAcknowledgement?: boolean;
  readonly nudgeDelivery: NudgeDeliveryPort;
  readonly broker: ContextBroker;
  readonly enqueueWrite: <T>(operation: () => T | PromiseLike<T>) => Promise<T>;
}

export interface AgentCheckpointInput {
  readonly runId: string;
  readonly idempotencyKey: string;
  readonly body: unknown;
  readonly requestBindingHash: string;
}

export type AgentCheckpointResponse = Omit<CheckpointMutationResult, 'preliminaryRecommendations'> & {
  readonly recommendations: readonly Recommendation[];
  readonly capabilities: CapabilityGatedIntakeResponse['capabilities'];
  readonly memoryPolicy: CapabilityGatedIntakeResponse['memoryPolicy'];
  readonly warnings: CapabilityGatedIntakeResponse['warnings'];
  readonly nextAction: CapabilityGatedIntakeResponse['nextAction'];
  readonly context: ContextBrokerResult['context'];
  readonly nudge: DeliveredNudge | null;
  readonly untrusted: true;
  readonly requestBindingHash: string;
};

function withoutCapabilityCatalog(value: unknown): unknown {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return value;
  const result = { ...(value as Record<string, unknown>) };
  delete result.capabilities;
  return result;
}

function checkpointSignalArray(value: unknown): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    throw new KiokukoError('INTEGRITY_ERROR', 'Checkpoint signals are invalid after validation');
  }
  return [...value];
}

function checkpointSignals(value: unknown): { changedPaths: string[]; errorSignatures: string[] } {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new KiokukoError('INTEGRITY_ERROR', 'Checkpoint signals are invalid after validation');
  }
  const request = value as Record<string, unknown>;
  return {
    changedPaths: checkpointSignalArray(request.changedPaths),
    errorSignatures: checkpointSignalArray(request.errorSignatures),
  };
}

function assertActiveCheckpointRun(run: { status: RunStatus }): asserts run is { status: 'active' } {
  const eligibility = checkpointEligibility(run.status);
  if (eligibility.allowed) return;
  throw new KiokukoError('CONFLICT', 'Checkpoint is not allowed for a non-active run', {
    checkpointEligibility: eligibility,
    runStatus: run.status,
  });
}

function brokerPersistence(dependencies: AgentCheckpointUseCaseDependencies) {
  return {
    enqueueWrite: <T>(operation: () => T): Promise<T> => dependencies.enqueueWrite(operation),
  };
}

function sameTaskProfile(
  left: CheckpointMutationResult['taskProfile'],
  right: ContextBrokerResult['taskProfile'],
): boolean {
  return left.taskType === right.taskType
    && left.target === right.target
    && left.expected === right.expected
    && left.constraints === right.constraints;
}

function checkpointIntegrity(): never {
  throw new KiokukoError('INTEGRITY_ERROR', 'Checkpoint mutation acknowledgement is inconsistent');
}

function assertMutationAcknowledgement(
  mutation: CheckpointMutationResult,
  runId: string,
): void {
  if (mutation.projection === null
    || mutation.runId !== runId
    || mutation.acceptedThrough !== mutation.projection.throughSequence
    || mutation.profileHash !== mutation.projection.profileHash
    || !sameTaskProfile(mutation.taskProfile, mutation.projection.taskProfile)) {
    checkpointIntegrity();
  }
  try {
    if (canonicalJson(mutation.preliminaryRecommendations)
      !== canonicalJson(buildRecommendations({ projection: mutation.projection, broker: {} }))) {
      checkpointIntegrity();
    }
  } catch {
    checkpointIntegrity();
  }
}

export class AgentCheckpointUseCase {
  constructor(private readonly dependencies: AgentCheckpointUseCaseDependencies) {}

  async execute(input: AgentCheckpointInput): Promise<AgentCheckpointResponse> {
    const catalog = requestCapabilityCatalog(input.body);
    const initialRun = this.dependencies.service.readRun({ runId: input.runId });
    assertActiveCheckpointRun(initialRun);
    assertCapabilityCatalogBinding(initialRun.metadata, catalog);
    const serviceRequest = withoutCapabilityCatalog(input.body);
    // The ledger mutation is committed before any broker work starts.
    const mutation = await this.dependencies.enqueueWrite(() => this.dependencies.checkpointMutation.checkpoint({
      runId: input.runId,
      idempotencyKey: input.idempotencyKey,
      request: serviceRequest,
    }));
    if (this.dependencies.validateMutationAcknowledgement !== false) {
      assertMutationAcknowledgement(mutation, input.runId);
    }
    const signals = checkpointSignals(serviceRequest);
    const gated = await this.dependencies.broker.queryGated({
      workspace: 'run-bound',
      runId: input.runId,
      characterBudget: mutation.characterBudget,
      changedPaths: signals.changedPaths,
      errorSignatures: signals.errorSignatures,
    }, (candidate) => {
      assertBrokerContextRun(candidate, input.runId);
      const memoryUse = deriveBrokerMemoryUseSignal(this.dependencies, candidate);
      const value = applyAgentCapabilityGateWithDeliveryObservation({
        task: initialRun.title ?? '',
        intakeStatus: brokerIntakeStatus(candidate.status),
        taskProfile: candidate.taskProfile,
        recommendedTags: candidate.recommendedTags,
        catalog,
        broker: candidate,
        memoryUseOverride: memoryUse,
      }, () => retrievableWorkspaceEntryCount(this.dependencies.database, initialRun.workspace));
      return {
        persist: value.context !== null || candidate.context === null,
        value,
        assertBeforePersist: () => {
          if (deriveBrokerMemoryUseSignal(this.dependencies, candidate) !== memoryUse) {
            throw new KiokukoError('CONFLICT', 'Memory capability decision changed before context persistence');
          }
        },
      };
    }, brokerPersistence(this.dependencies));
    const finalRun = this.dependencies.service.readRun({ runId: input.runId });
    assertActiveCheckpointRun(finalRun);
    if (finalRun.lastSequence !== gated.broker.acceptedThrough) {
      throw new KiokukoError('CONFLICT', 'Agent run changed while checkpoint context was being prepared');
    }
    const intakeStatus = brokerIntakeStatus(gated.broker.status);
    const projection = gated.broker.projection;
    if (intakeStatus === 'needs_answer' || projection === null) {
      throw new KiokukoError('INTEGRITY_ERROR', 'Checkpoint context is not bound to finalized intake');
    }
    const nudge = await this.dependencies.enqueueWrite(() => this.dependencies.nudgeDelivery.deliver({
      runId: input.runId,
      idempotencyKey: input.idempotencyKey,
      throughSequence: gated.broker.acceptedThrough,
      projection,
      recommendations: gated.value.recommendations,
    }));
    const { preliminaryRecommendations: _preliminaryRecommendations, ...mutationResponse } = mutation;
    return {
      ...mutationResponse,
      runStatus: finalRun.status,
      intakeStatus,
      taskProfile: { ...gated.broker.taskProfile, source: 'akinator+ledger-revisions' },
      profileHash: gated.broker.profileHash,
      projection,
      ...gated.value,
      nudge,
      requestBindingHash: input.requestBindingHash,
      untrusted: true,
    };
  }
}

export function checkpointSuccessResponse(value: AgentCheckpointResponse): ReturnType<typeof successEnvelope> {
  return successEnvelope('agent.checkpoint', value);
}
