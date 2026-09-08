import * as z from 'zod/v4';
import { canonicalContentHash } from '../serialization/validate.js';

export const EXECUTION_ROLES = ['ideal', 'zenki', 'gokiHead', 'gokiWorker', 'check'] as const;
export type ExecutionRole = typeof EXECUTION_ROLES[number];
const name = z.string().min(1).max(256).regex(/^[a-zA-Z0-9][a-zA-Z0-9._/-]*$/u);
export const orchestrationOptionsSchema = z.object({
  mode: z.enum(['ask', 'on', 'off']).default('ask'),
  customAgents: z.object(Object.fromEntries(EXECUTION_ROLES.map(role => [role, z.array(name).max(40).optional()])) as Record<ExecutionRole, z.ZodOptional<z.ZodArray<typeof name>>>).strict().default({}),
}).strict();
export type OrchestrationOptions = z.infer<typeof orchestrationOptionsSchema>;
export const candidateSchema = z.object({
  role: z.enum(EXECUTION_ROLES), agent: name, model: name,
  configurationDigest: z.string().regex(/^[a-f0-9]{64}$/u),
  unavailable: z.enum(['agent_missing', 'model_missing', 'provider_disconnected', 'tools_unsupported', 'permissions_invalid', 'depth_insufficient', 'catalog_unavailable']).nullable(),
}).strict();
export type ExecutionCandidate = z.infer<typeof candidateSchema>;
export const executionCatalogSchema = z.object({
  mode: z.enum(['ask', 'on', 'off']),
  candidates: z.array(candidateSchema).max(256),
}).strict();
export type ExecutionCatalog = z.infer<typeof executionCatalogSchema>;
export const roleSelectionSchema = z.object(Object.fromEntries(EXECUTION_ROLES.map(role => [role, name])) as Record<ExecutionRole, typeof name>).strict();
export type RoleSelection = z.infer<typeof roleSelectionSchema>;

export const EXECUTION_SELECTION_INSTRUCTIONS = 'For each new logical request, inspect execution. For bounded documentation wording changes recommend ordinary work. When mode is on, honor Enno enabled and ask only for the model configuration. When pending in ask mode, use the native question tool to choose ordinary work or Enno-Oduno, then a preset and optional per-role overrides; honor an explicit choice in the user request without asking again. Call task_execution_select with the exact runId, revision and a new idempotencyKey. A dismissed question is not consent. Ordinary work keeps memory and verification but never starts Enno-Oduno. Keep this choice for follow-ups and retries. Do not call task_prepare again. If a selected model fails, offer another registered model, ordinary work, or cancel; never silently substitute. Dispatch each role with the exact subagent_type and promptPrefix from execution.dispatch, followed by its self-contained directive. Only the parent submits Enno reports and holds execution identities. Await the role result before reporting it. Goki head delegates implementation to the selected worker using its supplied dispatch descriptor.';

const rolePrompt: Record<ExecutionRole, string> = {
  ideal: 'Derive the ideal and return the requested ideal report. Do not plan or implement.',
  zenki: 'Produce the requested bounded WorkPlan. Do not implement.',
  gokiHead: 'Coordinate the supplied approved WorkUnit. Delegate its implementation to the exact gokiWorker dispatch descriptor in the input; do not implement yourself. Return one aggregated outcome.',
  gokiWorker: 'Implement only the supplied approved WorkUnit and run its focused verification. Do not delegate or broaden scope. Return changed paths and verification evidence.',
  check: 'Review the supplied fresh verifier evidence against the approved contract, or perform the requested read-only meditation. Return the requested report. Do not implement or run verifiers yourself.',
};
export function rolePermission(role: ExecutionRole): Record<string, unknown> {
  return {
    '*': 'deny', read: 'allow', glob: 'allow', grep: 'allow', list: 'allow', skill: 'allow',
    ...(role === 'gokiWorker' ? { edit: 'allow', bash: 'allow' } : {}),
    task: role === 'gokiHead' ? { '*': 'allow' } : 'deny',
    'kiokuko_*': 'deny', external_directory: 'ask',
  };
}
export function agentDefinition(role: ExecutionRole, model: string) {
  return {
    description: `Kiokuko ${role}: ${model}`,
    mode: 'subagent' as const, model,
    prompt: `You are a delegated Kiokuko ${role}. ${rolePrompt[role]} The parent owns the run, leases, and all Kiokuko MCP writes. Do not call task_prepare or other Kiokuko tools. Do not start another orchestration or ask the user again. Follow only the supplied approved scope, role contract and selected local Skills. On failure return evidence to the parent without changing models.`,
    permission: rolePermission(role),
  };
}
export function managedAgentName(role: ExecutionRole, model: string): string {
  return `kiokuko-${role}-${model.replaceAll('/', '-')}`;
}
function preset(id: string, provider: string, planner: string, head: string, worker: string) {
  const models = { ideal: planner, zenki: planner, gokiHead: head, gokiWorker: worker, check: planner };
  return { id, agents: Object.fromEntries(EXECUTION_ROLES.map(role => [role, managedAgentName(role, `${provider}/${models[role]}`)])) as RoleSelection,
    models: Object.fromEntries(EXECUTION_ROLES.map(role => [role, `${provider}/${models[role]}`])) as Record<ExecutionRole, string> };
}
// Official model catalog names verified 2026-09-07; runtime availability is always checked separately.
export const EXECUTION_PRESETS = [
  preset('openai', 'openai', 'gpt-6-astra', 'gpt-5.6-sol', 'gpt-5.6-luna'),
  preset('zen-openai', 'opencode', 'gpt-6-astra', 'gpt-5.6-sol', 'gpt-5.6-luna'),
  preset('zen-glm', 'opencode', 'glm-5.3', 'glm-5.3', 'glm-5.3-flash'),
  preset('go-glm', 'opencode-go', 'glm-5.3', 'glm-5.3', 'glm-5.3-flash'),
  preset('go-qwen', 'opencode-go', 'qwen3.8-max', 'qwen3.8-max', 'qwen3.8-flash'),
  preset('openrouter-glm', 'openrouter', 'z-ai/glm-5.3', 'z-ai/glm-5.3', 'z-ai/glm-5.3-flash'),
  preset('openrouter-qwen', 'openrouter', 'qwen/qwen3.8-max-0902', 'qwen/qwen3.8-max-0902', 'qwen/qwen3.8-flash'),
];
export const MANAGED_EXECUTION_AGENTS = Object.fromEntries([
  ...EXECUTION_PRESETS.flatMap(p => EXECUTION_ROLES.map(role => [p.agents[role], agentDefinition(role, p.models[role])] as const)),
  ...['opencode/deepseek-v4-flash', 'opencode-go/deepseek-v4-flash', 'openrouter/deepseek/deepseek-v4-flash'].map(model => [managedAgentName('gokiWorker', model), agentDefinition('gokiWorker', model)] as const),
]);
export function object(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
export function roleRegistrations(options: OrchestrationOptions): Array<{ role: ExecutionRole; agent: string }> {
  return EXECUTION_ROLES.flatMap(role => [...new Set([
    ...Object.keys(MANAGED_EXECUTION_AGENTS).filter(agent => agent.startsWith(`kiokuko-${role}-`)),
    ...(options.customAgents[role] ?? []),
  ])].map(agent => ({ role, agent })));
}

/** Project only routing fields; never retain provider credentials, endpoints or request headers. */
export function buildExecutionCatalog(config: unknown, providers: unknown, options: OrchestrationOptions): ExecutionCatalog {
  const root = object(config);
  const agents = object(root.agent);
  const catalog = object(providers);
  const connected = Array.isArray(catalog.connected) ? catalog.connected : [];
  const all = Array.isArray(catalog.all) ? catalog.all.map(object) : [];
  return { mode: options.mode, candidates: roleRegistrations(options).map(({ role, agent }) => {
    const definition = object(agents[agent]);
    const model = typeof definition.model === 'string' && name.safeParse(definition.model).success ? definition.model : 'unavailable/model';
    const separator = model.indexOf('/');
    const provider = model.slice(0, separator);
    const modelId = model.slice(separator + 1);
    const availableModel = object(object(all.find(item => item.id === provider)?.models)[modelId]);
    const permission = object(definition.permission);
    const expected = rolePermission(role);
    // Conservative: customized roles must retain the explicit role permission envelope.
    const validPermissions = definition.tools === undefined && canonicalContentHash(permission) === canonicalContentHash(expected);
    const unavailable: ExecutionCandidate['unavailable'] = Object.keys(definition).length === 0 || definition.disable === true || definition.mode !== 'subagent' ? 'agent_missing'
      : model === 'unavailable/model' || separator < 1 ? 'model_missing'
      : !validPermissions ? 'permissions_invalid'
      : role === 'gokiHead' && Number(root.subagent_depth ?? 1) < 2 ? 'depth_insufficient'
      : !Array.isArray(catalog.connected) ? 'catalog_unavailable'
      : !connected.includes(provider) ? 'provider_disconnected'
      : Object.keys(availableModel).length === 0 ? 'model_missing'
      : object(availableModel.capabilities).toolcall !== true ? 'tools_unsupported' : null;
    return { role, agent, model, configurationDigest: canonicalContentHash({ model, permission, prompt: definition.prompt ?? '', mode: definition.mode ?? null }), unavailable };
  }) };
}
