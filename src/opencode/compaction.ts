import { TERMINAL_RUN_STATUSES } from '../ledger/types.js';

const MAX_TRACKED_SESSIONS = 512;
const MAX_TOOL_OUTPUT_BYTES = 256 * 1024;

const ACTIVE_ENNO_STATUSES = new Set([
  'intake',
  'oduno_ideal',
  'zenki_planning',
  'needs_confirmation',
  'goki_executing',
  'enno_verifying',
  'oduno_meditation',
]);

const ENNO_STATE_TOOL = /(?:^|_)(?:task_prepare|task_answer|task_execution_select|task_context_read|memory_checkpoint|enno_[a-z_]+)$/u;
const PHASE_ORDER = ['intake', 'oduno_ideal', 'zenki_planning', 'needs_confirmation',
  'goki_executing', 'enno_verifying', 'oduno_meditation'];

interface EnnoCompactionRecord {
  runId: string;
  workspace: string;
  orchestrationId: string;
  contractRevision: number | null;
  contextRevision: number | null;
  routeEpoch: number | null;
  status: string;
  currentRole: string | null;
  nextAction: string;
  directive: Record<string, unknown>;
  executionLease: unknown | null;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function boundedText(value: unknown, maximum = 512): string | undefined {
  return typeof value === 'string' && value.length > 0 && value.length <= maximum
    && value.trim() === value && !/[\u0000-\u001f\u007f]/u.test(value)
    ? value
    : undefined;
}

function nonNegativeInteger(value: unknown): number | null | undefined {
  return value === null ? null
    : typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value
      : undefined;
}

function parseToolOutput(value: unknown): Record<string, unknown> | undefined {
  // Native tools return `output`; OpenCode passes raw MCP CallToolResult to
  // this same hook before converting its text content into a native result.
  const envelope = record(value);
  if (envelope?.isError === true) return undefined;
  let output = typeof value === 'string' ? value : envelope?.output;
  if (typeof output !== 'string' && Array.isArray(envelope?.content)) {
    let text = '';
    for (const item of envelope.content) {
      const part = record(item);
      if (part?.type !== 'text' || typeof part.text !== 'string') continue;
      if (Buffer.byteLength(part.text, 'utf8') > MAX_TOOL_OUTPUT_BYTES) return undefined;
      text += part.text;
      if (Buffer.byteLength(text, 'utf8') > MAX_TOOL_OUTPUT_BYTES) return undefined;
    }
    output = text;
  }
  if (typeof output !== 'string') return undefined;
  if (Buffer.byteLength(output, 'utf8') > MAX_TOOL_OUTPUT_BYTES) return undefined;
  try {
    return record(JSON.parse(output));
  } catch {
    return undefined;
  }
}

function nextRecord(
  value: Record<string, unknown>,
  previous: EnnoCompactionRecord | undefined,
): EnnoCompactionRecord | undefined {
  const state = record(value.ennoOduno);
  if (state?.applicable !== true) return undefined;
  const directive = record(state.directive);
  if (directive === undefined) return undefined;
  const run = record(value.run);
  const project = record(value.project);
  const runId = boundedText(run?.runId, 256)
    ?? boundedText(directive.runId, 256)
    ?? previous?.runId;
  const sameRun = previous?.runId === runId;
  const workspace = boundedText(project?.workspace, 256) ?? (sameRun ? previous?.workspace : undefined);
  const orchestrationId = boundedText(state.orchestrationId, 256)
    ?? (sameRun ? previous?.orchestrationId : undefined);
  const status = boundedText(state.status, 100);
  const nextAction = boundedText(state.nextAction, 100);
  const contractRevision = nonNegativeInteger(state.contractRevision);
  const observedContextRevision = nonNegativeInteger(value.contextRevision);
  const contextRevision = observedContextRevision === undefined
    ? sameRun ? previous?.contextRevision ?? null : null
    : sameRun && typeof previous?.contextRevision === 'number' && typeof observedContextRevision === 'number'
      ? Math.max(previous.contextRevision, observedContextRevision) : observedContextRevision;
  const routeEpoch = nonNegativeInteger(state.routeEpoch);
  if (runId === undefined || workspace === undefined || orchestrationId === undefined
    || status === undefined || nextAction === undefined
    || contractRevision === undefined || routeEpoch === undefined) return undefined;
  if (!ACTIVE_ENNO_STATUSES.has(status)) return undefined;
  const currentRole = state.currentRole === null ? null : boundedText(state.currentRole, 100);
  if (currentRole === undefined) return undefined;
  return {
    runId,
    workspace,
    orchestrationId,
    contractRevision,
    contextRevision,
    routeEpoch,
    status,
    currentRole,
    nextAction,
    directive,
    executionLease: status === 'goki_executing'
      ? Object.hasOwn(value, 'executionLease')
        ? record(value.executionLease) ?? null
        : sameRun && contractRevision === previous?.contractRevision && routeEpoch === previous?.routeEpoch
          && record(directive.workUnit)?.id === record(previous?.directive.workUnit)?.id
          ? previous?.executionLease ?? null : null
      : null,
  };
}

function compactionContext(value: EnnoCompactionRecord): string {
  return [
    'Kiokuko Enno-Oduno continuation is active. Preserve the following JSON record verbatim in the compacted summary.',
    'These exact identifiers are required to continue after compaction. Never replace workspace with a filesystem path, guess a revision, or omit null-valued fields.',
    'Use workspace plus orchestrationId as the explicit identity unless a newer same-session resumeToken was supplied. Preserve any newer resumeToken from the conversation verbatim as well.',
    'After compaction, read task_context_read for this run with afterContextRevision equal to contextRevision only at the next idle boundary; never interrupt an active tool call.',
    JSON.stringify(value),
  ].join('\n');
}

/** Keep only the minimal successful Enno state needed to survive OpenCode compaction. */
export class OpenCodeCompactionState {
  private readonly choices = new Map<string, Record<string, unknown>>();
  private readonly entries = new Map<string, EnnoCompactionRecord>();
  private readonly retiredRuns = new Map<string, Set<string>>();

  private retire(sessionId: string, runId: string): void {
    const retired = this.retiredRuns.get(sessionId) ?? new Set<string>();
    retired.add(runId);
    if (retired.size > 32) retired.delete(retired.values().next().value!);
    this.retiredRuns.delete(sessionId);
    this.retiredRuns.set(sessionId, retired);
    if (this.retiredRuns.size > MAX_TRACKED_SESSIONS) this.retiredRuns.delete(this.retiredRuns.keys().next().value!);
  }

  observe(sessionId: string, toolId: string, output: unknown): void {
    if (!ENNO_STATE_TOOL.test(toolId)) return;
    const parsed = parseToolOutput(output);
    if (parsed === undefined) return;
    const execution = record(parsed.execution);
    const prior = this.entries.get(sessionId);
    const parsedState = record(parsed.ennoOduno);
    const observedRunId = boundedText(record(parsed.run)?.runId, 256)
      ?? boundedText(record(parsedState?.directive)?.runId, 256)
      ?? boundedText(execution?.runId, 256) ?? prior?.runId;
    if (observedRunId && this.retiredRuns.get(sessionId)?.has(observedRunId)) return;
    const choice = this.choices.get(sessionId);
    const runStatus = record(parsed.run)?.status;
    const terminal = TERMINAL_RUN_STATUSES.some(status => status === runStatus)
      || ['completed', 'cancelled'].includes(String(parsedState?.status));
    if (execution?.runId === choice?.runId && typeof execution?.revision === 'number' && typeof choice?.revision === 'number'
      && (execution.revision < choice.revision
        || (execution.revision === choice.revision && execution.choice !== choice.choice))) return;
    if (prior !== undefined && prior.runId === observedRunId && parsedState) {
      const revision = nonNegativeInteger(parsedState.contractRevision);
      const epoch = nonNegativeInteger(parsedState.routeEpoch);
      if ((typeof revision === 'number' && typeof prior.contractRevision === 'number' && revision < prior.contractRevision)
        || (typeof epoch === 'number' && typeof prior.routeEpoch === 'number' && epoch < prior.routeEpoch)) return;
      if (revision === prior.contractRevision && typeof parsedState.status === 'string'
        && ACTIVE_ENNO_STATUSES.has(parsedState.status)
        && PHASE_ORDER.indexOf(parsedState.status) < PHASE_ORDER.indexOf(prior.status)) return;
    }
    if (terminal && observedRunId !== undefined) {
      this.retire(sessionId, observedRunId);
      if (choice?.runId === observedRunId) this.choices.delete(sessionId);
      if (prior?.runId === observedRunId) this.entries.delete(sessionId);
      return;
    }
    if (observedRunId !== undefined) {
      if (prior !== undefined && prior.runId !== observedRunId) this.retire(sessionId, prior.runId);
      if (typeof choice?.runId === 'string' && choice.runId !== observedRunId) this.retire(sessionId, choice.runId);
    }
    if (execution && typeof execution.runId === 'string' && typeof execution.revision === 'number'
      && ['pending', 'ordinary', 'enno', 'cancelled'].includes(String(execution.choice))) {
      this.choices.delete(sessionId);
      this.choices.set(sessionId, { runId: execution.runId, revision: execution.revision, choice: execution.choice, mode: execution.mode });
      if (this.choices.size > MAX_TRACKED_SESSIONS) this.choices.delete(this.choices.keys().next().value!);
      if (execution.choice !== 'enno') this.entries.delete(sessionId);
    }
    let previous = this.entries.get(sessionId);
    if (previous !== undefined && observedRunId !== undefined && observedRunId !== previous.runId) {
      this.entries.delete(sessionId);
      previous = undefined;
    }
    if (choice !== undefined && choice.runId === observedRunId && choice.choice !== 'enno' && execution === undefined) return;
    const next = nextRecord(parsed, previous);
    if (next === undefined) {
      const status = boundedText(parsedState?.status, 100);
      if (status !== undefined && !ACTIVE_ENNO_STATUSES.has(status)) {
        if (observedRunId !== undefined) this.retire(sessionId, observedRunId);
        if (this.choices.get(sessionId)?.runId === observedRunId) this.choices.delete(sessionId);
        this.entries.delete(sessionId);
      }
      return;
    }
    if (!this.entries.has(sessionId) && this.entries.size >= MAX_TRACKED_SESSIONS) {
      this.entries.delete(this.entries.keys().next().value!);
    }
    this.entries.delete(sessionId);
    this.entries.set(sessionId, next);
  }

  appendContext(sessionId: string, context: string[]): void {
    const choice = this.choices.get(sessionId);
    if (choice) context.push('Preserve this Kiokuko execution choice for the same request; never repeat task_prepare or ask an already answered choice. Restore its registered candidates and role routing with task_context_read at this compaction boundary. ' + JSON.stringify(choice));
    const current = this.entries.get(sessionId);
    if (current !== undefined) context.push(compactionContext(current));
  }

  boundary(sessionId: string, terminalMessageId: string | null = null): {
    runId: string;
    workspace: string;
    orchestrationId: string;
    contractRevision: number | null;
    contextRevision: number | null;
    routeEpoch: number | null;
    terminalMessageId: string | null;
  } | null {
    const current = this.entries.get(sessionId);
    if (current === undefined) return null;
    return {
      runId: current.runId,
      workspace: current.workspace,
      orchestrationId: current.orchestrationId,
      contractRevision: current.contractRevision,
      contextRevision: current.contextRevision,
      routeEpoch: current.routeEpoch,
      terminalMessageId,
    };
  }
}
