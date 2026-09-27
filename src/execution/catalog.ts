import * as z from 'zod/v4';
import { canonicalContentHash } from '../serialization/validate.js';

export const EXECUTION_ROLES = ['ideal', 'zenki', 'gokiHead', 'gokiWorker', 'check'] as const;
export type ExecutionRole = typeof EXECUTION_ROLES[number];
const name = z.string().min(1).max(256).regex(/^[a-zA-Z0-9][a-zA-Z0-9._/#-]*$/u);
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

export const EXECUTION_SELECTION_INSTRUCTIONS = 'For each new logical request, inspect execution. For bounded documentation wording changes recommend ordinary work. When mode is on, honor Enno enabled and ask only for the model configuration. When pending in ask mode, use the native question tool to choose ordinary work or Enno-Oduno, then a preset and optional per-role overrides; honor an explicit choice in the user request without asking again. Call task_execution_select with the exact runId, revision and a new idempotencyKey. A dismissed question is not consent. Ordinary work keeps memory and verification but never starts Enno-Oduno. Keep this choice for follow-ups and retries. Do not call task_prepare again. If a selected model fails, offer another registered model, ordinary work, or cancel; never silently substitute. Dispatch each role with the exact agent and promptPrefix from execution.dispatch, followed by its self-contained directive. Only the parent submits Enno reports and holds execution identities. Await the subagent result before reporting it. Goki head delegates implementation to the selected worker using its supplied dispatch descriptor.';

const rolePrompt: Record<ExecutionRole, string> = {
  ideal: 'Derive the ideal and return the requested ideal report. Do not plan or implement.',
  zenki: 'Produce the requested bounded WorkPlan. Do not implement.',
  gokiHead: 'Coordinate the supplied approved WorkUnit. Delegate its implementation to the exact gokiWorker dispatch descriptor in the input; do not implement yourself. Return one aggregated outcome.',
  gokiWorker: 'Implement only the supplied approved WorkUnit and run its focused verification. Do not delegate or broaden scope. Return changed paths and verification evidence.',
  check: 'Review the supplied fresh verifier evidence against the approved contract, or perform the requested read-only meditation. Return the requested report. Do not implement or run verifiers yourself.',
};
export function rolePermission(role: ExecutionRole): Array<{ action: string; resource: string; effect: 'allow' | 'ask' | 'deny' }> {
  return [
    { action: '*', resource: '*', effect: 'deny' },
    ...['read', 'glob', 'grep', 'list', 'skill'].map(action => ({ action, resource: '*', effect: 'allow' as const })),
    ...(role === 'gokiWorker' ? ['edit', 'shell'].map(action => ({ action, resource: '*', effect: 'allow' as const })) : []),
    ...(role === 'gokiHead' ? [{ action: 'subagent', resource: '*', effect: 'allow' as const }] : []),
    { action: 'kiokuko_*', resource: '*', effect: 'deny' },
    { action: 'external_directory', resource: '*', effect: 'ask' },
  ];
}
export function agentDefinition(role: ExecutionRole, model: string) {
  return {
    description: `Kiokuko ${role}: ${model}`,
    mode: 'subagent' as const, model,
    system: `You are a delegated Kiokuko ${role}. ${rolePrompt[role]} The parent owns the run, leases, and all Kiokuko MCP writes. Do not call task_prepare or other Kiokuko tools. Do not start another orchestration or ask the user again. Follow only the supplied approved scope, role contract and selected local Skills. On failure return evidence to the parent without changing models.`,
    permissions: rolePermission(role),
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

/** Project only V2 routing fields; never retain credentials, endpoints or headers. */
export function buildExecutionCatalog(input: {
  agents: readonly unknown[];
  models: readonly unknown[];
  providers: readonly unknown[];
  subagentDepth: number;
}, options: OrchestrationOptions): ExecutionCatalog {
  const agents = input.agents.map(object);
  const models = input.models.map(object);
  const providers = input.providers.map(object);
  return { mode: options.mode, candidates: roleRegistrations(options).map(({ role, agent }) => {
    const definition = agents.find(item => item.id === agent) ?? {};
    const reference = object(definition.model);
    const model = typeof reference.providerID === 'string' && typeof reference.id === 'string'
      ? `${reference.providerID}/${reference.id}${typeof reference.variant === 'string' ? `#${reference.variant}` : ''}`
      : 'unavailable/model';
    const provider = String(reference.providerID ?? '');
    const modelId = String(reference.id ?? '');
    const availableModel = models.find(item => item.providerID === provider && (item.modelID === modelId || item.id === modelId)) ?? {};
    const permissions = definition.permissions;
    const expected = rolePermission(role);
    // OpenCode prepends its defaults and can append the same configured agent
    // more than once when several config sources contribute it. The final
    // complete Kiokuko rule block determines the effective ordered policy.
    const effectivePermissions = Array.isArray(permissions) ? permissions.slice(-expected.length) : [];
    const validPermissions = canonicalContentHash(effectivePermissions) === canonicalContentHash(expected);
    const unavailable: ExecutionCandidate['unavailable'] = Object.keys(definition).length === 0 || definition.mode !== 'subagent' ? 'agent_missing'
      : model === 'unavailable/model' ? 'model_missing'
      : !validPermissions ? 'permissions_invalid'
      : role === 'gokiHead' && input.subagentDepth < 2 ? 'depth_insufficient'
      : !providers.some(item => item.id === provider && item.activation !== 'disabled') ? 'provider_disconnected'
      : Object.keys(availableModel).length === 0 ? 'model_missing'
      : object(availableModel.capabilities).tools !== true || availableModel.enabled !== true ? 'tools_unsupported' : null;
    return { role, agent, model, configurationDigest: canonicalContentHash({ model, permissions: validPermissions ? effectivePermissions : permissions ?? null, system: definition.system ?? '', mode: definition.mode ?? null }), unavailable };
  }) };
}
