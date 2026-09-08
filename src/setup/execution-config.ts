import { applyEdits, modify, parse } from 'jsonc-parser';
import { canonicalContentHash } from '../serialization/validate.js';
import { KiokukoError } from '../errors.js';
import { MANAGED_EXECUTION_AGENTS, object, orchestrationOptionsSchema } from '../execution/catalog.js';

/** Extend only the managed plugin tuple and absent or unmodified managed agents. */
export function renderExecutionConfig(source: string, pluginIndex: number, mode?: 'ask' | 'on' | 'off'): string {
  const root = object(parse(source));
  if (root.agent !== undefined && (typeof root.agent !== 'object' || root.agent === null || Array.isArray(root.agent))) {
    throw new KiokukoError('VALIDATION_ERROR', 'OpenCode agent must be an object');
  }
  const plugins = root.plugin as unknown[];
  const entry = plugins[pluginIndex];
  const priorOptions = Array.isArray(entry) ? object(entry[1]) : {};
  const priorOrchestration = priorOptions.orchestration ?? {};
  const options = orchestrationOptionsSchema.parse(priorOrchestration);
  if (mode !== undefined) options.mode = mode;
  const owned = object(priorOptions.orchestrationManagedAgents);
  const hashes = { ...owned };
  const agents = object(root.agent);
  const formattingOptions = { insertSpaces: true, tabSize: 2, eol: source.includes('\r\n') ? '\r\n' : '\n' };
  let content = source;
  const set = (keys: (string | number)[], value: unknown) => {
    content = applyEdits(content, modify(content, keys, value, { formattingOptions }));
  };
  for (const [agent, definition] of Object.entries(MANAGED_EXECUTION_AGENTS)) {
    const existing = agents[agent];
    if (existing !== undefined && owned[agent] !== canonicalContentHash(existing)) {
      if (owned[agent] === undefined && canonicalContentHash(existing) !== canonicalContentHash(definition)) {
        throw new KiokukoError('CONFLICT', `OpenCode agent name is already owned by the user: ${agent}`);
      }
      if (owned[agent] !== undefined) continue; // Preserve user edits, including their original ownership digest.
    }
    if (existing === undefined || canonicalContentHash(existing) !== canonicalContentHash(definition)) set(['agent', agent], definition);
    hashes[agent] = canonicalContentHash(definition);
  }
  if (root.subagent_depth === undefined) set(['subagent_depth'], 2);
  if (!Array.isArray(entry)) set(['plugin', pluginIndex], [entry, {}]);
  if (priorOptions.orchestration === undefined) set(['plugin', pluginIndex, 1, 'orchestration'], options);
  else {
    if (object(priorOptions.orchestration).mode !== options.mode) set(['plugin', pluginIndex, 1, 'orchestration', 'mode'], options.mode);
    if (object(priorOptions.orchestration).customAgents === undefined) set(['plugin', pluginIndex, 1, 'orchestration', 'customAgents'], options.customAgents);
  }
  if (canonicalContentHash(owned) !== canonicalContentHash(hashes)) set(['plugin', pluginIndex, 1, 'orchestrationManagedAgents'], hashes);
  return content;
}
