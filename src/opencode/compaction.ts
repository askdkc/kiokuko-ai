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

const ENNO_STATE_TOOL = /(?:^|_)(?:task_prepare|task_answer|enno_[a-z_]+)$/u;

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

function parseToolOutput(output: string): Record<string, unknown> | undefined {
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
    : observedContextRevision;
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
        : sameRun ? previous?.executionLease ?? null : null
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
  private readonly entries = new Map<string, EnnoCompactionRecord>();

  observe(sessionId: string, toolId: string, output: string): void {
    if (!ENNO_STATE_TOOL.test(toolId)) return;
    const parsed = parseToolOutput(output);
    if (parsed === undefined) return;
    let previous = this.entries.get(sessionId);
    const parsedState = record(parsed.ennoOduno);
    const observedRunId = boundedText(record(parsed.run)?.runId, 256)
      ?? boundedText(record(parsedState?.directive)?.runId, 256);
    if (previous !== undefined && observedRunId !== undefined && observedRunId !== previous.runId) {
      this.entries.delete(sessionId);
      previous = undefined;
    }
    const next = nextRecord(parsed, previous);
    if (next === undefined) {
      const status = boundedText(parsedState?.status, 100);
      if (status !== undefined && !ACTIVE_ENNO_STATUSES.has(status)) this.entries.delete(sessionId);
      return;
    }
    if (!this.entries.has(sessionId) && this.entries.size >= MAX_TRACKED_SESSIONS) {
      this.entries.delete(this.entries.keys().next().value!);
    }
    this.entries.delete(sessionId);
    this.entries.set(sessionId, next);
  }

  appendContext(sessionId: string, context: string[]): void {
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
