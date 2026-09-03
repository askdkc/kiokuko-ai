import { randomUUID } from 'node:crypto';
import type { SqliteDatabase } from '../db/adapter.js';
import { withImmediateTransaction } from '../db/transaction.js';
import { KiokukoError } from '../errors.js';
import { executeTaskRequestInTransaction } from './idempotency.js';
import { sanitizeRunMetadata, sanitizeTask } from '../ledger/redaction.js';
import type {
  ClientInput,
  JsonObject,
  JsonValue,
  LedgerEventInput,
  LedgerEventType,
  RunRecord,
  RunStatus,
  TaskInput,
} from '../ledger/types.js';
import { LedgerStore } from '../ledger/store.js';
import { listLedgerEvents, listLedgerRuns, readLedgerRun } from '../ledger/query.js';
import { AKINATOR_POLICY_VERSION, evaluateProfile, profileHash } from '../akinator/domain.js';
import { answerAkinatorInTransaction, startAkinatorInTransaction } from '../akinator/service.js';
import {
  finalizeRunIntakeLink,
  insertRunIntakeLink,
  markRunIntakeProfileSource,
  readAkinatorSession,
  readRunIntakeLink,
  type AkinatorProfileSources,
} from '../akinator/store.js';
import type { AkinatorQuestion, AkinatorResult, TaskProfile } from '../akinator/types.js';
import type { LedgerEventsPage, LedgerRunView, LedgerRunsPage } from '../ledger/query.js';
import { assertCapabilityCatalogBinding, bindCapabilityCatalog } from '../akinator/capability-binding.js';

const PROFILE_FIELDS = ['taskType', 'target', 'expected', 'constraints'] as const;

export interface TaskRunServiceOptions {
  readonly now?: () => string;
  readonly home?: string;
  readonly runIdFactory?: () => string;
  readonly sessionIdFactory?: () => string;
  readonly eventIdFactory?: () => string;
}

export interface CreateOpenCodeTaskRunInput {
  readonly requestId: string;
  readonly workspace: string;
  readonly task: TaskInput;
  readonly metadata: JsonObject;
  readonly capabilities?: unknown;
  readonly clientVersion?: string;
  readonly sourceSessionId?: string;
  readonly parentRunId?: string;
  readonly startedAt?: string;
}

export interface AnswerOpenCodeTaskRunInput {
  readonly requestId: string;
  readonly runId: string;
  readonly questionId: keyof TaskProfile;
  readonly value: string;
  readonly capabilities?: unknown;
}

export interface TaskRunIntakeResult {
  runId: string;
  runStatus: RunStatus;
  intakeSessionId: string;
  intakeStatus: AkinatorResult['status'];
  question: AkinatorQuestion | null;
  missingFields: Array<keyof TaskProfile>;
  recommendedTags: string[];
  taskProfile: TaskProfile;
  profileHash: string | null;
  context: null;
  untrusted: true;
}

interface AnswerOptions {
  readonly assertBeforeAnswer?: () => void;
}

function jsonResult<T>(value: T): JsonValue {
  return value as unknown as JsonValue;
}

function notFound(): never {
  throw new KiokukoError('NOT_FOUND', 'Task run not found');
}

function conflict(message: string): never {
  throw new KiokukoError('CONFLICT', message);
}

function profileSources(task: TaskInput, profile: TaskProfile): AkinatorProfileSources {
  const sources: AkinatorProfileSources = {};
  for (const field of PROFILE_FIELDS) {
    const supplied = task.profileHints[field];
    if (supplied !== null && supplied !== undefined) sources[field] = 'client_supplied';
    else if (field === 'taskType' && profile.taskType !== null) sources[field] = 'inferred';
  }
  return sources;
}

export class TaskRunService {
  constructor(
    private readonly database: SqliteDatabase,
    private readonly options: TaskRunServiceOptions = {},
  ) {}

  createRun(input: CreateOpenCodeTaskRunInput): TaskRunIntakeResult {
    const task = sanitizeTask(input.task, {
      workspace: input.workspace,
      ...(this.options.home === undefined ? {} : { home: this.options.home }),
    }).value;
    const metadata = sanitizeRunMetadata(
      bindCapabilityCatalog(input.metadata, input.capabilities),
      {
        workspace: input.workspace,
        ...(this.options.home === undefined ? {} : { home: this.options.home }),
      },
    ).value as JsonObject;
    const client: ClientInput = {
      kind: 'opencode',
      ...(input.clientVersion === undefined ? {} : { version: input.clientVersion }),
      ...(input.sourceSessionId === undefined ? {} : { sessionId: input.sourceSessionId }),
    };
    const request = jsonResult({
      workspace: input.workspace,
      task,
      metadata,
      client,
      ...(input.parentRunId === undefined ? {} : { parentRunId: input.parentRunId }),
      ...(input.startedAt === undefined ? {} : { startedAt: input.startedAt }),
    });
    const now = this.currentTime();
    return withImmediateTransaction(this.database, () => executeTaskRequestInTransaction(
      this.database,
      { scope: 'opencode.task.create', key: input.requestId, request, createdAt: now },
      () => {
        const runId = this.options.runIdFactory?.() ?? randomUUID();
        const sessionId = this.options.sessionIdFactory?.() ?? randomUUID();
        const store = this.ledgerStore(input.workspace);
        const run = store.createRunInTransaction({
          runId,
          workspace: input.workspace,
          protocolVersion: '1',
          client,
          captureProfile: 'minimal',
          coverage: {
            run: 'unavailable',
            tool: 'unavailable',
            command: 'unavailable',
            file: 'unavailable',
            approval: 'unavailable',
          },
          task,
          metadata,
          ...(input.parentRunId === undefined ? {} : { parentRunId: input.parentRunId }),
          ...(input.startedAt === undefined ? {} : { startedAt: input.startedAt }),
        }, now);
        const result = startAkinatorInTransaction(this.database, {
          workspace: input.workspace,
          task: task.query,
          profileHints: task.profileHints,
          now,
          idFactory: () => sessionId,
        });
        insertRunIntakeLink(this.database, {
          runId,
          sessionId,
          workspace: input.workspace,
          policyVersion: AKINATOR_POLICY_VERSION,
          profileSchemaVersion: 1,
          profileSources: profileSources(task, result.session.profile),
          initialProfileHash: null,
          recommendedTags: result.recommendedTags,
          linkedAt: now,
          finalizedAt: null,
        });
        const events: LedgerEventInput[] = [this.lifecycleEvent('intake.started', {
          intakeSessionId: sessionId,
          status: result.status,
          missingFields: result.missingFields,
        }, now)];
        let finalRun = run;
        if (result.status === 'ready' || result.status === 'exhausted') {
          events.push(this.lifecycleEvent(result.status === 'ready' ? 'intake.ready' : 'intake.exhausted', {
            profile: result.session.profile,
            profileHash: profileHash(result.session.profile),
            recommendedTags: result.recommendedTags,
            missingFields: result.missingFields,
          }, now));
          events.push(this.lifecycleEvent('run.started', {
            intakeStatus: result.status,
            profileHash: profileHash(result.session.profile),
            recommendedTags: result.recommendedTags,
          }, now));
        }
        store.appendBatchInTransaction(runId, { events });
        if (result.status === 'ready' || result.status === 'exhausted') {
          finalizeRunIntakeLink(this.database, {
            workspace: input.workspace,
            runId,
            profileHash: profileHash(result.session.profile),
            recommendedTags: result.recommendedTags,
            finalizedAt: now,
          });
          finalRun = store.updateRunStatusInTransaction(runId, 'active', now);
        }
        return this.intakeResult(runId, finalRun.status, result);
      },
    ));
  }

  answerIntake(input: AnswerOpenCodeTaskRunInput, options: AnswerOptions = {}): TaskRunIntakeResult {
    const initialRun = this.requireRun(input.runId);
    assertCapabilityCatalogBinding(initialRun.metadata, input.capabilities);
    const now = this.currentTime();
    return withImmediateTransaction(this.database, () => {
      options.assertBeforeAnswer?.();
      return executeTaskRequestInTransaction(
        this.database,
        {
          scope: 'opencode.task.answer',
          key: input.requestId,
          request: jsonResult({
            runId: input.runId,
            questionId: input.questionId,
            value: input.value,
            capabilities: input.capabilities ?? null,
          }),
          createdAt: now,
        },
        () => {
          const run = this.requireRun(input.runId);
          const link = readRunIntakeLink(this.database, { workspace: run.workspace, runId: run.runId });
          const mutation = answerAkinatorInTransaction(this.database, {
            workspace: run.workspace,
            sessionId: link.sessionId,
            questionId: input.questionId,
            value: input.value,
            now,
          });
          if (mutation.replayed) {
            return this.intakeResult(run.runId, this.requireRun(run.runId).status, mutation.result);
          }
          if (run.status !== 'intake') conflict('Task run is not waiting for intake');
          markRunIntakeProfileSource(this.database, {
            workspace: run.workspace,
            runId: run.runId,
            field: input.questionId,
          });
          const events: LedgerEventInput[] = [this.lifecycleEvent('intake.answered', {
            questionId: input.questionId,
            value: input.value,
          }, now)];
          if (mutation.result.status === 'ready' || mutation.result.status === 'exhausted') {
            events.push(this.lifecycleEvent(mutation.result.status === 'ready' ? 'intake.ready' : 'intake.exhausted', {
              profile: mutation.result.session.profile,
              profileHash: profileHash(mutation.result.session.profile),
              recommendedTags: mutation.result.recommendedTags,
              missingFields: mutation.result.missingFields,
            }, now));
            events.push(this.lifecycleEvent('run.started', {
              intakeStatus: mutation.result.status,
              profileHash: profileHash(mutation.result.session.profile),
              recommendedTags: mutation.result.recommendedTags,
            }, now));
          }
          this.ledgerStore(run.workspace).appendBatchInTransaction(run.runId, { events });
          let finalRun = this.requireRun(run.runId);
          if (mutation.result.status === 'ready' || mutation.result.status === 'exhausted') {
            finalizeRunIntakeLink(this.database, {
              workspace: run.workspace,
              runId: run.runId,
              profileHash: profileHash(mutation.result.session.profile),
              recommendedTags: mutation.result.recommendedTags,
              finalizedAt: now,
            });
            finalRun = this.ledgerStore(run.workspace).updateRunStatusInTransaction(run.runId, 'active', now);
          }
          return this.intakeResult(run.runId, finalRun.status, mutation.result);
        },
      );
    });
  }

  listRuns(input: unknown): LedgerRunsPage {
    return listLedgerRuns(this.database, input);
  }

  readRun(runId: string): LedgerRunView {
    const run = this.requireRun(runId);
    return readLedgerRun(this.database, { workspace: run.workspace, runId });
  }

  readIntake(runId: string): TaskRunIntakeResult {
    const run = this.requireRun(runId);
    const link = readRunIntakeLink(this.database, { workspace: run.workspace, runId });
    const session = readAkinatorSession(this.database, { workspace: run.workspace, sessionId: link.sessionId });
    const evaluation = evaluateProfile(session.profile, session.questionCount);
    return this.intakeResult(runId, run.status, {
      status: evaluation.status,
      session,
      question: evaluation.question,
      missingFields: evaluation.missingFields,
      recommendedTags: evaluation.recommendedTags,
    }, link.initialProfileHash);
  }

  listEvents(input: { runId: string; after?: number; type?: LedgerEventType; limit?: number }): LedgerEventsPage {
    const run = this.requireRun(input.runId);
    return listLedgerEvents(this.database, {
      workspace: run.workspace,
      ...input,
    });
  }

  private intakeResult(
    runId: string,
    runStatus: RunStatus,
    result: AkinatorResult,
    finalizedHash?: string | null,
  ): TaskRunIntakeResult {
    const finalized = finalizedHash !== undefined
      ? finalizedHash !== null
      : runStatus === 'active' && (result.status === 'ready' || result.status === 'exhausted');
    const currentHash = profileHash(result.session.profile);
    return {
      runId,
      runStatus,
      intakeSessionId: result.session.id,
      intakeStatus: result.status,
      question: result.question,
      missingFields: [...result.missingFields],
      recommendedTags: [...result.recommendedTags],
      taskProfile: { ...result.session.profile },
      profileHash: finalized ? finalizedHash ?? currentHash : null,
      context: null,
      untrusted: true,
    };
  }

  private lifecycleEvent(eventType: LedgerEventType, payload: unknown, occurredAt: string): LedgerEventInput {
    return {
      eventId: this.options.eventIdFactory?.() ?? randomUUID(),
      eventType,
      actor: 'kiokuko-opencode',
      occurredAt,
      payload: jsonResult(payload),
    };
  }

  private ledgerStore(workspace: string): LedgerStore {
    return new LedgerStore(this.database, {
      now: () => this.currentTime(),
      workspace,
      ...(this.options.home === undefined ? {} : { home: this.options.home }),
    });
  }

  private requireRun(runId: string): RunRecord {
    return new LedgerStore(this.database).readRun(runId) ?? notFound();
  }

  private currentTime(): string {
    return this.options.now?.() ?? new Date().toISOString();
  }
}
