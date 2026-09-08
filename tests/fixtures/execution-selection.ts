import { prepareOpenCodeTask, selectOpenCodeTaskExecution, type PrepareOpenCodeTaskInput } from '../../src/akinator/opencode-task.js';
import type { SqliteDatabase } from '../../src/db/adapter.js';
import { buildExecutionCatalog, MANAGED_EXECUTION_AGENTS, orchestrationOptionsSchema, object } from '../../src/execution/catalog.js';

export function fixtureProviders(agents: Record<string, unknown> = MANAGED_EXECUTION_AGENTS) {
  const providers: Record<string, { id: string; models: Record<string, unknown> }> = {};
  for (const value of Object.values(agents)) {
    const model = String(object(value).model);
    const slash = model.indexOf('/');
    const provider = model.slice(0, slash);
    providers[provider] ??= { id: provider, models: {} };
    providers[provider].models[model.slice(slash + 1)] = { capabilities: { toolcall: true } };
  }
  return { all: Object.values(providers), connected: Object.keys(providers) };
}
export function fixtureExecutionCatalog() {
  return buildExecutionCatalog({ agent: MANAGED_EXECUTION_AGENTS, subagent_depth: 2 }, fixtureProviders(), orchestrationOptionsSchema.parse({}));
}
/** Existing orchestration tests explicitly opt in before exercising their phase contract. */
export async function prepareSelectedTask(database: SqliteDatabase, input: PrepareOpenCodeTaskInput) {
  const prepared = await prepareOpenCodeTask(database, { ...input, executionCatalog: fixtureExecutionCatalog() });
  if (prepared.execution?.choice === 'pending') {
    const selection = selectOpenCodeTaskExecution(database, {
      runId: prepared.run.runId, expectedRevision: 0, idempotencyKey: 'fixture-execution-selection', choice: 'enno', preset: 'openai',
      ...(input.cwd === undefined ? {} : { cwd: input.cwd }),
    });
    return { ...prepared, execution: selection.execution, ennoOduno: selection.ennoOduno };
  }
  return prepared;
}
