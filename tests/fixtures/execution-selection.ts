import { prepareOpenCodeTask, selectOpenCodeTaskExecution, type PrepareOpenCodeTaskInput } from '../../src/akinator/opencode-task.js';
import type { SqliteDatabase } from '../../src/db/adapter.js';
import { buildExecutionCatalog, MANAGED_EXECUTION_AGENTS, orchestrationOptionsSchema, object } from '../../src/execution/catalog.js';

export function fixtureProviders(agents: Record<string, unknown> = MANAGED_EXECUTION_AGENTS) {
  return [...new Set(Object.values(agents).map(value => String(object(value).model).split('/')[0]))]
    .map(id => ({ id, activation: 'enabled' }));
}
export function fixtureCatalogInput(agents: Record<string, unknown> = MANAGED_EXECUTION_AGENTS, subagentDepth = 2) {
  const definitions = Object.entries(agents).map(([id, value]) => {
    const definition = object(value);
    const model = String(definition.model);
    const slash = model.indexOf('/');
    return { ...definition, id, model: { providerID: model.slice(0, slash), id: model.slice(slash + 1) } };
  });
  return { agents: definitions, models: definitions.map(definition => ({
    providerID: definition.model.providerID, modelID: definition.model.id,
    capabilities: { tools: true }, enabled: true,
  })), providers: fixtureProviders(agents), subagentDepth };
}
export function fixtureExecutionCatalog() {
  return buildExecutionCatalog(fixtureCatalogInput(), orchestrationOptionsSchema.parse({}));
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
