import type { SqliteDatabase } from '../../src/db/adapter.js';
import { TaskRunService, type TaskRunServiceOptions } from '../../src/task-run/service.js';
import type { ClientInput, JsonObject, JsonValue, TaskInput } from '../../src/ledger/types.js';
import type { TaskProfile } from '../../src/akinator/types.js';

interface OpenInput {
  readonly idempotencyKey: string;
  readonly request: {
    readonly workspace: string;
    readonly client: ClientInput;
    readonly task: Omit<TaskInput, 'profileHints'> & {
      readonly profileHints: Partial<TaskProfile> | Record<string, unknown>;
    };
    readonly metadata: JsonObject;
    readonly capabilities?: JsonValue;
    readonly parentRunId?: string;
    readonly startedAt?: string;
    readonly apiVersion?: '1';
    readonly captureProfile?: unknown;
    readonly coverage?: unknown;
  };
}

interface AnswerInput {
  readonly runId: string;
  readonly idempotencyKey: string;
  readonly request: {
    readonly questionId: keyof TaskProfile;
    readonly value: string;
    readonly capabilities?: JsonValue;
    readonly apiVersion?: '1';
  };
}

function intakeAliases<T extends { readonly question: unknown }>(result: T): T & {
  readonly currentQuestion: T['question'];
  readonly intake: { readonly question: T['question'] };
} {
  return Object.assign(result, {
    currentQuestion: result.question,
    intake: { question: result.question },
  });
}

/** Keeps core integration tests compact without restoring the removed Agent API. */
export class OpenCodeTaskRunDriver {
  private readonly service: TaskRunService;

  constructor(database: SqliteDatabase, options: TaskRunServiceOptions = {}) {
    this.service = new TaskRunService(database, options);
  }

  openRun(input: OpenInput) {
    const { request } = input;
    const hints = request.task.profileHints as Partial<TaskProfile>;
    const task: TaskInput = {
      ...request.task,
      profileHints: {
        taskType: hints.taskType ?? null,
        target: hints.target ?? null,
        expected: hints.expected ?? null,
        constraints: hints.constraints ?? null,
      },
    };
    return intakeAliases(this.service.createRun({
      requestId: input.idempotencyKey,
      workspace: request.workspace,
      task,
      metadata: request.metadata,
      ...(request.capabilities === undefined ? {} : { capabilities: request.capabilities }),
      ...(request.client.version === undefined ? {} : { clientVersion: request.client.version }),
      ...(request.client.sessionId === undefined ? {} : { sourceSessionId: request.client.sessionId }),
      ...(request.parentRunId === undefined ? {} : { parentRunId: request.parentRunId }),
      ...(request.startedAt === undefined ? {} : { startedAt: request.startedAt }),
    }));
  }

  answerIntake(input: AnswerInput, options: { readonly assertBeforeAnswer?: () => void } = {}) {
    return intakeAliases(this.service.answerIntake({
      requestId: input.idempotencyKey,
      runId: input.runId,
      questionId: input.request.questionId,
      value: input.request.value,
      ...(input.request.capabilities === undefined ? {} : { capabilities: input.request.capabilities }),
    }, options));
  }

  readRun(input: { readonly runId: string }) {
    return this.service.readRun(input.runId);
  }
}
