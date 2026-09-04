import process from 'node:process';

export const DEFAULT_MCP_REQUEST_TIMEOUT_MS = 90_000;
export const MIN_MCP_REQUEST_TIMEOUT_MS = 10;
export const MAX_MCP_REQUEST_TIMEOUT_MS = 90_000;

export const MCP_READ_TIMEOUT_MS = 30_000;
export const MCP_EXTERNAL_IO_TIMEOUT_MS = 10_000;
export const MCP_MUTATION_TIMEOUT_MS = 60_000;

export type McpToolOperation =
  | 'task_prepare'
  | 'task_answer'
  | 'task_context_read'
  | 'memory_checkpoint'
  | 'curator_check'
  | 'curator_globalize'
  | 'enno_advice_submit'
  | 'enno_advice_read'
  | 'enno_ideal_submit'
  | 'enno_plan_submit'
  | 'enno_answer'
  | 'enno_work_report'
  | 'enno_work_claim'
  | 'enno_verify_prepare'
  | 'enno_finish'
  | 'enno_meditation_submit';

export type McpDeadlineClass = 'read' | 'external' | 'mutation';

export interface McpDeadlinePolicy {
  readMs: number;
  externalMs: number;
  mutationMs: number;
  hardMaxMs: number;
}

export interface McpDeadlinePolicyOverrides {
  readMs?: number;
  externalMs?: number;
  mutationMs?: number;
  hardMaxMs?: number;
}

export interface McpDeadlineContext {
  readonly operation: McpToolOperation;
  readonly deadlineAt: number;
  remainingMs(): number;
  childTimeoutMs(requestedMs: number): number;
}

export interface RunWithMcpDeadlineOptions<T> {
  operation: McpToolOperation;
  timeoutMs?: number;
  policy?: McpDeadlinePolicy;
  signal?: AbortSignal;
  operationFn: (signal: AbortSignal, context: McpDeadlineContext) => Promise<T> | T;
}

export class McpRequestTimeoutError extends Error {
  readonly code = 'MCP_REQUEST_TIMEOUT' as const;
  readonly retryable = true as const;

  constructor(readonly operation: McpToolOperation) {
    super('MCP request timed out');
    this.name = 'McpRequestTimeoutError';
  }
}

export class McpRequestCancelledError extends Error {
  readonly code = 'MCP_REQUEST_CANCELLED' as const;
  readonly retryable = false as const;

  constructor(readonly operation: McpToolOperation) {
    super('MCP request was cancelled');
    this.name = 'McpRequestCancelledError';
  }
}

export const DEFAULT_MCP_DEADLINE_POLICY: Readonly<McpDeadlinePolicy> = Object.freeze({
  readMs: MCP_READ_TIMEOUT_MS,
  externalMs: MCP_EXTERNAL_IO_TIMEOUT_MS,
  mutationMs: MCP_MUTATION_TIMEOUT_MS,
  hardMaxMs: DEFAULT_MCP_REQUEST_TIMEOUT_MS,
});

const EXTERNAL_OPERATIONS: ReadonlySet<McpToolOperation> = new Set([
  'task_prepare',
  'task_answer',
]);

const MUTATION_OPERATIONS: ReadonlySet<McpToolOperation> = new Set([
  'memory_checkpoint',
  'curator_globalize',
  'enno_advice_submit',
  'enno_ideal_submit',
  'enno_plan_submit',
  'enno_answer',
  'enno_work_report',
  'enno_work_claim',
  'enno_verify_prepare',
  'enno_finish',
  'enno_meditation_submit',
]);

function assertTimeoutMs(value: number, label: string): number {
  if (!Number.isSafeInteger(value)
    || value < MIN_MCP_REQUEST_TIMEOUT_MS
    || value > MAX_MCP_REQUEST_TIMEOUT_MS) {
    throw new Error(`${label} must be an integer between ${MIN_MCP_REQUEST_TIMEOUT_MS} and ${MAX_MCP_REQUEST_TIMEOUT_MS} milliseconds`);
  }
  return value;
}

function positiveIntegerEnvironmentValue(name: string): number | undefined {
  const raw = process.env[name];
  if (raw === undefined || raw.length === 0) return undefined;
  const value = Number(raw);
  return Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

export function createMcpDeadlinePolicy(overrides: McpDeadlinePolicyOverrides = {}): McpDeadlinePolicy {
  const policy = {
    readMs: overrides.readMs
      ?? positiveIntegerEnvironmentValue('KIOKUKO_MCP_READ_TIMEOUT_MS')
      ?? DEFAULT_MCP_DEADLINE_POLICY.readMs,
    externalMs: overrides.externalMs
      ?? positiveIntegerEnvironmentValue('KIOKUKO_MCP_EXTERNAL_IO_TIMEOUT_MS')
      ?? DEFAULT_MCP_DEADLINE_POLICY.externalMs,
    mutationMs: overrides.mutationMs
      ?? positiveIntegerEnvironmentValue('KIOKUKO_MCP_MUTATION_TIMEOUT_MS')
      ?? DEFAULT_MCP_DEADLINE_POLICY.mutationMs,
    hardMaxMs: overrides.hardMaxMs
      ?? positiveIntegerEnvironmentValue('KIOKUKO_MCP_HARD_MAX_TIMEOUT_MS')
      ?? DEFAULT_MCP_DEADLINE_POLICY.hardMaxMs,
  };
  assertTimeoutMs(policy.readMs, 'read timeout');
  assertTimeoutMs(policy.externalMs, 'external I/O timeout');
  assertTimeoutMs(policy.mutationMs, 'mutation timeout');
  assertTimeoutMs(policy.hardMaxMs, 'hard maximum timeout');
  if (policy.readMs > policy.hardMaxMs || policy.externalMs > policy.hardMaxMs || policy.mutationMs > policy.hardMaxMs) {
    throw new Error('MCP operation timeout must not exceed the hard maximum timeout');
  }
  return policy;
}

export function operationDeadlineClass(operation: McpToolOperation): McpDeadlineClass {
  if (EXTERNAL_OPERATIONS.has(operation)) return 'external';
  if (MUTATION_OPERATIONS.has(operation)) return 'mutation';
  return 'read';
}

export function timeoutForOperation(
  operation: McpToolOperation,
  policy: McpDeadlinePolicy = DEFAULT_MCP_DEADLINE_POLICY,
): number {
  const validated = createMcpDeadlinePolicy(policy);
  switch (operationDeadlineClass(operation)) {
    case 'external': return validated.externalMs;
    case 'mutation': return validated.mutationMs;
    case 'read': return validated.readMs;
  }
}

function abortReasonIsTimeout(reason: unknown): boolean {
  return reason instanceof McpRequestTimeoutError;
}

export async function runWithMcpDeadline<T>({
  operation,
  timeoutMs,
  policy = DEFAULT_MCP_DEADLINE_POLICY,
  signal,
  operationFn,
}: RunWithMcpDeadlineOptions<T>): Promise<T> {
  const selectedTimeoutMs = assertTimeoutMs(timeoutMs ?? timeoutForOperation(operation, policy), 'MCP request timeout');
  const deadlineAt = Date.now() + selectedTimeoutMs;
  const controller = new AbortController();
  const context: McpDeadlineContext = {
    operation,
    deadlineAt,
    remainingMs: () => Math.max(0, deadlineAt - Date.now()),
    childTimeoutMs: (requestedMs) => Math.min(assertTimeoutMs(requestedMs, 'child timeout'), Math.max(0, deadlineAt - Date.now())),
  };

  if (signal?.aborted) throw new McpRequestCancelledError(operation);

  return await new Promise<T>((resolve, reject) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const cleanup = (): void => {
      if (timer !== undefined) clearTimeout(timer);
      signal?.removeEventListener('abort', onCallerAbort);
    };

    const settle = (settlement: () => void): void => {
      if (settled) return;
      settled = true;
      cleanup();
      settlement();
    };

    const onCallerAbort = (): void => {
      const error = new McpRequestCancelledError(operation);
      controller.abort(error);
      settle(() => reject(error));
    };

    const onTimeout = (): void => {
      const error = new McpRequestTimeoutError(operation);
      controller.abort(error);
      settle(() => reject(error));
    };

    signal?.addEventListener('abort', onCallerAbort, { once: true });
    timer = setTimeout(onTimeout, selectedTimeoutMs);
    void Promise.resolve()
      .then(() => {
        if (controller.signal.aborted) throw controller.signal.reason;
        return operationFn(controller.signal, context);
      })
      .then(
        (value) => settle(() => resolve(value)),
        (error: unknown) => settle(() => reject(
          abortReasonIsTimeout(controller.signal.reason) ? new McpRequestTimeoutError(operation) : error,
        )),
      );
  });
}
